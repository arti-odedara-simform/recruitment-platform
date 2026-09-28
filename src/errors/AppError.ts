/**
 * RFC-7807-ish problem shape (PLAN.md §4). Every error the API emits serialises to this;
 * no raw Prisma error ever reaches a client.
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  errors?: FieldIssue[];
  [extension: string]: unknown;
}

export interface FieldIssue {
  path: string;
  message: string;
}

export class AppError extends Error {
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly detail: string | undefined;
  readonly issues: FieldIssue[] | undefined;
  readonly extensions: Record<string, unknown>;

  constructor(args: {
    status: number;
    type: string;
    title: string;
    detail?: string;
    issues?: FieldIssue[];
    extensions?: Record<string, unknown>;
  }) {
    super(args.detail ?? args.title);
    this.name = new.target.name;
    this.status = args.status;
    this.type = args.type;
    this.title = args.title;
    this.detail = args.detail;
    this.issues = args.issues;
    this.extensions = args.extensions ?? {};
    Error.captureStackTrace?.(this, new.target);
  }

  toProblem(): ProblemDetails {
    const problem: ProblemDetails = {
      type: this.type,
      title: this.title,
      status: this.status,
      ...this.extensions,
    };
    if (this.detail !== undefined) problem.detail = this.detail;
    if (this.issues !== undefined) problem.errors = this.issues;
    return problem;
  }
}

export class BadRequestError extends AppError {
  constructor(detail: string, issues?: FieldIssue[]) {
    super({
      status: 400,
      type: 'https://httpstatuses.io/400',
      title: 'Bad Request',
      detail,
      ...(issues ? { issues } : {}),
    });
  }
}

export class UnauthorizedError extends AppError {
  constructor(detail = 'A valid bearer token is required.') {
    super({ status: 401, type: 'https://httpstatuses.io/401', title: 'Unauthorized', detail });
  }
}

export class ForbiddenError extends AppError {
  constructor(detail = 'Your role does not permit this action.') {
    super({ status: 403, type: 'https://httpstatuses.io/403', title: 'Forbidden', detail });
  }
}

/**
 * Out-of-scope resources 404 rather than 403 — a 403 would confirm the record exists
 * (PLAN.md §4). Deliberate, and asserted by test.
 */
export class NotFoundError extends AppError {
  constructor(detail = 'No such resource.') {
    super({ status: 404, type: 'https://httpstatuses.io/404', title: 'Not Found', detail });
  }
}

export class ConflictError extends AppError {
  constructor(detail: string) {
    super({ status: 409, type: 'https://httpstatuses.io/409', title: 'Conflict', detail });
  }
}

/** An illegal move through the stage machine (PLAN.md §3): the body carries the legal set. */
export class InvalidTransitionError extends AppError {
  constructor(from: string, to: string, allowed: readonly string[]) {
    super({
      status: 422,
      type: 'https://httpstatuses.io/422',
      title: 'Invalid Stage Transition',
      detail: `${from} -> ${to} is not a legal transition.`,
      extensions: { from, to, allowed },
    });
  }
}
