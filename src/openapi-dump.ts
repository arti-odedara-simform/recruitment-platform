import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { buildOpenApiDocument } from './http/openapi/registry.js';

/**
 * Writes the generated OpenAPI document to openapi.json — `npm run openapi:json`.
 *
 * The document is built from the route modules' own `registerOperation` calls, so it has
 * to be *loaded* before it can be dumped: `createApp()` is what imports every router.
 * Without that call the registry is empty and this writes a spec with no paths in it,
 * which is a mistake worth naming here because the failure looks like a working script.
 *
 * The file itself is gitignored. It exists so `web/` can generate its client types from
 * the same zod schemas `validate()` enforces, without a running server — see
 * web/package.json's `api:types`.
 */
const OUT = fileURLToPath(new URL('../openapi.json', import.meta.url));

createApp();
const document = buildOpenApiDocument();
const paths = Object.keys(document.paths as Record<string, unknown>).length;

await writeFile(OUT, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(`[openapi] wrote openapi.json — ${paths} paths`);
