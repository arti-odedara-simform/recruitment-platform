import { ApiError } from '../api/client.js';

export function Loading({ label }: { label: string }) {
  return (
    <p className="muted pad" role="status">
      {label}
    </p>
  );
}

/**
 * Renders what the API said rather than a generic apology. A 403 here is information —
 * this role is not permitted this view — and saying so is more useful than "error".
 */
export function ErrorNotice({
  error,
  onRetry,
}: {
  error: ApiError | Error;
  onRetry?: () => void;
}) {
  const isApi = error instanceof ApiError;
  const title = isApi ? (error.problem?.title ?? 'Request failed') : 'Something went wrong';
  const detail = isApi ? (error.problem?.detail ?? error.message) : error.message;

  return (
    <div className="notice error pad" role="alert">
      <strong>
        {title}
        {isApi ? ` (${error.status})` : ''}
      </strong>
      <p>{detail}</p>
      {onRetry !== undefined && (
        <button type="button" className="link" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}
