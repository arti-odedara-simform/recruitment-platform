import { useState } from 'react';
import { ApiError, createRole, users } from '../api/client.js';
import type { Schemas } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { ErrorNotice } from './Feedback.js';

/**
 * Opening a req — the one write that creates something for the rest of the app to be
 * about. Everything else on the recruiter path acts on a req that already exists.
 *
 * The hiring manager is picked from `GET /users?role=HIRING_MANAGER` rather than typed,
 * because ownership is what scopes a hiring manager's whole view: `GET /roles` and
 * `GET /pipeline` show them the reqs they own, so a req handed to the wrong person is one
 * its "manager" can never see. The API verifies the named user's role before the write
 * regardless — the picker keeps that 400 from being the way a recruiter finds out.
 */

const MAX_TITLE = 200;

export function OpenReqForm({ onOpened }: { onOpened: (req: Schemas['Role']) => void }) {
  const managers = useApi(() => users('HIRING_MANAGER'), []);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [hiringManagerId, setHiringManagerId] = useState('');
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [busy, setBusy] = useState(false);

  const trimmedTitle = title.trim();
  const fieldErrors = error instanceof ApiError ? error.fieldErrors : {};

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || trimmedTitle === '' || hiringManagerId === '') return;

    setBusy(true);
    setError(null);

    try {
      const req = await createRole({ title: trimmedTitle, hiringManagerId });
      setTitle('');
      setHiringManagerId('');
      setOpen(false);
      onOpened(req);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="pad bordered">
        <button type="button" onClick={() => setOpen(true)}>
          Open a req
        </button>
      </div>
    );
  }

  return (
    <form className="pad bordered create" onSubmit={submit}>
      <p className="muted">
        A req opens OPEN — there is no status to choose, and closing one is a separate act
        with its own audit row that this API does not have yet. The opening is written with
        an audit event in the same transaction.
      </p>

      <div className="create-fields">
        <label>
          Title
          <input
            type="text"
            value={title}
            maxLength={MAX_TITLE}
            placeholder="Staff Backend Engineer"
            onChange={(event) => setTitle(event.target.value)}
            required
          />
          {fieldErrors['body.title'] !== undefined && (
            <span className="error">{fieldErrors['body.title']}</span>
          )}
        </label>

        <label>
          Hiring manager
          {managers.error !== null ? (
            <ErrorNotice error={managers.error} onRetry={managers.reload} />
          ) : (
            <select
              value={hiringManagerId}
              onChange={(event) => setHiringManagerId(event.target.value)}
              disabled={managers.loading}
              required
            >
              <option value="">
                {managers.loading ? 'Loading…' : 'Choose a hiring manager…'}
              </option>
              {(managers.data ?? []).map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </select>
          )}
          {fieldErrors['body.hiringManagerId'] !== undefined && (
            <span className="error">{fieldErrors['body.hiringManagerId']}</span>
          )}
        </label>
      </div>

      <div className="actions">
        <button type="submit" disabled={busy || trimmedTitle === '' || hiringManagerId === ''}>
          {busy ? 'Opening…' : 'Open req'}
        </button>
        <button type="button" className="link" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>

      {error !== null && <ErrorNotice error={error} />}
    </form>
  );
}
