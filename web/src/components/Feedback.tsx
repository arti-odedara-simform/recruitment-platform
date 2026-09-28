import { ApiError } from '../api/client.js';
import { Icon } from './ui.js';

export function Loading({ label }: { label: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden />
      {label}
    </div>
  );
}

/**
 * The status code is the API's vocabulary, not the reader's — so the headline is a
 * sentence, and the API's own detail (which is written for people) goes underneath.
 */
function headline(error: ApiError | Error): string {
  if (!(error instanceof ApiError)) return 'Something went wrong';
  switch (error.status) {
    case 403:
      return 'You don’t have access to this';
    case 404:
      return 'We couldn’t find that';
    case 409:
      return 'That already exists';
    case 400:
    case 422:
      return error.problem?.title ?? 'That couldn’t be saved';
    default:
      return error.status >= 500 ? 'The server ran into a problem' : (error.problem?.title ?? 'Request failed');
  }
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
  const detail = isApi ? (error.problem?.detail ?? error.message) : error.message;

  return (
    <div className="notice error" role="alert">
      <Icon name="alert" />
      <div className="notice-body">
        <strong>{headline(error)}</strong>
        {detail !== '' && <p>{detail}</p>}
        {onRetry !== undefined && (
          <button type="button" className="link" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}
