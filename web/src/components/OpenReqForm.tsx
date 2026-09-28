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

export function OpenReqForm({
  onOpened,
  onCancel,
}: {
  onOpened: (req: Schemas['Role']) => void;
  onCancel: () => void;
}) {
  const managers = useApi(() => users('HIRING_MANAGER'), []);
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
      onOpened(req);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <header className="card-head">
        <div>
          <h2>Open a requisition</h2>
          <p>It opens straight away, and the hiring manager can see it as soon as it does.</p>
        </div>
      </header>

      <div className="card-body form">
        <div className="form-row">
          <label className="field">
            Job title
            <input
              type="text"
              value={title}
              maxLength={MAX_TITLE}
              placeholder="e.g. Staff Backend Engineer"
              onChange={(event) => setTitle(event.target.value)}
              autoFocus
              required
            />
            {fieldErrors['body.title'] !== undefined && (
              <span className="error">{fieldErrors['body.title']}</span>
            )}
          </label>

          <label className="field">
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
                <option value="">{managers.loading ? 'Loading…' : 'Choose a hiring manager'}</option>
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

        {error !== null && <ErrorNotice error={error} />}
      </div>

      <footer className="card-foot actions end">
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" disabled={busy || trimmedTitle === '' || hiringManagerId === ''}>
          {busy ? 'Opening…' : 'Open requisition'}
        </button>
      </footer>
    </form>
  );
}
