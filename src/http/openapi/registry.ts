import { z, type ZodType } from 'zod';
import { env } from '../../config/env.js';

/**
 * The OpenAPI document, generated from the very zod schemas `validate()` enforces.
 *
 * The point is that it cannot drift. A hand-written spec for the ~18 endpoints in
 * PLAN.md §4 would be accurate on the day it was written and wrong by D10; here the
 * request schema in the document *is* the object the middleware rejects bad input with.
 * Response schemas are the one part that is not self-enforcing, so they are pinned by a
 * contract test instead (tests/openapi.test.ts) that parses real responses against them.
 *
 * Route modules call `registerOperation` next to the route they describe, so the docs
 * are reviewed in the same diff as the handler.
 */

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';

export interface OperationSpec {
  method: Method;
  /** The Express path, `:param` and all — converted to OpenAPI `{param}` on build. */
  path: string;
  summary: string;
  description?: string;
  tags: string[];
  /** Omitted means the route is behind `requireAuth` (PLAN.md §4: almost everything is). */
  security?: 'none';
  request?: {
    body?: ZodType;
    params?: ZodType;
    query?: ZodType;
  };
  responses: Array<{
    status: number;
    description: string;
    schema?: ZodType;
  }>;
}

const operations: OperationSpec[] = [];

export function registerOperation(spec: OperationSpec): void {
  operations.push(spec);
}

/** `/applications/:candidateId/:roleId/stage` -> `/applications/{candidateId}/{roleId}/stage` */
function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/** Named schemas, hoisted out of zod's `$defs` — see `toSchema`. */
type Components = Record<string, unknown>;

/**
 * Rewrites every `$ref` in a generated schema from JSON Schema's `#/$defs/X` to
 * OpenAPI's `#/components/schemas/X`.
 *
 * This is the one genuinely lossy spot in the conversion, and skipping it produces a
 * document that looks fine and is quietly broken: a `.meta({ id })` makes zod emit
 * `{"$ref": "#/$defs/PublicUser"}`, and nothing in an OpenAPI document lives at
 * `#/$defs`. Swagger UI renders those models as unresolved. Caught by running the
 * generated spec through `redocly lint`, not by reading it.
 */
function rewriteRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node === null || typeof node !== 'object') return node;

  return Object.fromEntries(
    Object.entries(node as Record<string, unknown>).map(([key, value]) =>
      key === '$ref' && typeof value === 'string'
        ? [key, value.replace(/^#\/\$defs\//, '#/components/schemas/')]
        : [key, rewriteRefs(value)],
    ),
  );
}

/**
 * OpenAPI 3.1 is a superset of JSON Schema 2020-12, which is exactly what zod emits — so
 * the conversion is close to a pass-through rather than a lossy translation.
 *
 * Two things still have to be moved. `$schema` comes off: it is meaningful in a
 * standalone schema document, not inside `components`. And any `$defs` zod produced for
 * schemas carrying a `.meta({ id })` are hoisted into the shared `components.schemas`,
 * so `PublicUser` appears once in the document and once in the Swagger UI model list
 * rather than being re-inlined at every route that returns it.
 */
function toSchema(
  schema: ZodType,
  io: 'input' | 'output',
  components: Components,
): Record<string, unknown> {
  const json = z.toJSONSchema(schema, {
    io,
    target: 'draft-2020-12',
    // Some zod constructs (transforms, pipes) have no JSON Schema equivalent. Emitting
    // `{}` for those keeps the document valid and honest — "any value" — rather than
    // failing the whole build over one annotation.
    unrepresentable: 'any',
  }) as Record<string, unknown>;

  delete json.$schema;

  const defs = json.$defs as Record<string, unknown> | undefined;
  delete json.$defs;

  for (const [name, definition] of Object.entries(defs ?? {})) {
    components[name] = rewriteRefs(definition);
  }

  return rewriteRefs(json) as Record<string, unknown>;
}

/**
 * A zod object describing path or query params becomes an OpenAPI `parameters` array —
 * one entry per property, `required` derived from the object's own required list.
 */
function toParameters(schema: ZodType, location: 'path' | 'query', components: Components): unknown[] {
  const json = toSchema(schema, 'input', components);
  const properties = (json.properties ?? {}) as Record<string, unknown>;
  const required = new Set((json.required as string[] | undefined) ?? []);

  return Object.entries(properties).map(([name, propertySchema]) => ({
    name,
    in: location,
    // Path parameters are required by definition in OpenAPI, whatever the schema says.
    required: location === 'path' ? true : required.has(name),
    schema: propertySchema,
  }));
}

function toOperation(spec: OperationSpec, components: Components): Record<string, unknown> {
  const parameters = [
    ...(spec.request?.params ? toParameters(spec.request.params, 'path', components) : []),
    ...(spec.request?.query ? toParameters(spec.request.query, 'query', components) : []),
  ];

  const responses: Record<string, unknown> = {};
  for (const response of spec.responses) {
    responses[String(response.status)] = {
      description: response.description,
      ...(response.schema
        ? {
            content: {
              [response.status >= 400 ? 'application/problem+json' : 'application/json']: {
                schema: toSchema(response.schema, 'output', components),
              },
            },
          }
        : {}),
    };
  }

  return {
    summary: spec.summary,
    ...(spec.description ? { description: spec.description } : {}),
    tags: spec.tags,
    operationId: `${spec.method}${toOpenApiPath(spec.path).replace(/[^A-Za-z0-9]+(.)/g, (_, c: string) => c.toUpperCase())}`,
    // An empty array *clears* the document-wide requirement for this one operation —
    // that is how the two anonymous routes in PLAN.md §4 are expressed.
    security: spec.security === 'none' ? [] : [{ bearerAuth: [] }],
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(spec.request?.body
      ? {
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: toSchema(spec.request.body, 'input', components) },
            },
          },
        }
      : {}),
    responses,
  };
}

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  // Accumulated as operations are converted; every `.meta({ id })` schema lands here.
  const schemas: Components = {};

  for (const spec of operations) {
    const path = toOpenApiPath(spec.path);
    paths[path] ??= {};
    paths[path][spec.method] = toOperation(spec, schemas);
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Recruitment Pipeline POC',
      version: '0.1.0',
      description:
        'REST API for the recruitment pipeline POC. See PLAN.md for the design and ' +
        'README.md for the seeded development credentials.\n\n' +
        'Every route requires a bearer token except `POST /auth/login` and `GET /health` ' +
        '(PLAN.md §4). Log in, copy the `token` from the response, and paste it into ' +
        '**Authorize** above to try the rest.',
    },
    servers: [{ url: `http://localhost:${env.PORT}`, description: 'Local development' }],
    tags: [
      { name: 'Auth', description: 'Login and the identity behind a bearer token.' },
      {
        name: 'Candidates',
        description:
          'Scoped candidate reads. The field set follows the role, and the scope is in the ' +
          'query rather than applied after it (PLAN.md §1).',
      },
      { name: 'Health', description: 'Liveness, including the database round-trip.' },
    ],
    components: {
      schemas,
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
    // Document-wide default: everything needs a token unless an operation clears it.
    // Fail-closed, so a route added without thinking about auth is documented as guarded.
    security: [{ bearerAuth: [] }],
    paths,
  };
}

/** Exposed for the contract test, which asserts every registered route is reachable. */
export function registeredOperations(): readonly OperationSpec[] {
  return operations;
}
