import { useEffect, useState } from 'react';
import { ApiError, candidates, createApplication, roles } from '../api/client.js';
import type { Schemas } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { ErrorNotice } from './Feedback.js';
import { Icon, Person } from './ui.js';

/**
 * Putting a candidate onto a req.
 *
 * Only OPEN reqs are offered: the API refuses a closed one with a 400 from inside the
 * transaction, and a picker that lists reqs a recruiter cannot use is a picker that
 * teaches them to ignore its errors.
 *
 * Candidates are found through `GET /candidates` — the directory — so someone who has
 * never been on a req is as reachable as someone who is on three. The search is
 * debounced and capped at one short page: this is a picker, not a second directory.
 */

const SEARCH_DEBOUNCE_MS = 250;
const RESULTS = 8;

type Candidate = Schemas['CandidatePage']['items'][number];

export function AddToReqForm({
  onAdded,
  onClose,
}: {
  /** Refetch: the new row belongs in the list this form sits under. */
  onAdded: () => void;
  onClose: () => void;
}) {
  const openReqs = useApi(() => roles('OPEN'), []);

  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Candidate | null>(null);
  const [roleId, setRoleId] = useState('');
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(draft.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft]);

  const found = useApi(() => candidates({ q, page: 1, pageSize: RESULTS }), [q]);

  const fieldErrors = error instanceof ApiError ? error.fieldErrors : {};
  const duplicate = error instanceof ApiError && error.status === 409;
  const candidateId = picked?.id ?? '';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || candidateId === '' || roleId === '') return;

    setBusy(true);
    setError(null);

    try {
      await createApplication({ candidateId, roleId });
      onAdded();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));

      /**
       * 409 is the unique index saying this candidate is already on this req — a second
       * tab, or a recruiter who did not know a colleague had got there first. The row
       * they wanted exists, so refetching puts it in front of them; the notice stays up
       * to explain why nothing new appeared.
       */
      if (cause instanceof ApiError && cause.status === 409) onAdded();
    } finally {
      setBusy(false);
    }
  }

  const results = found.data?.items ?? [];

  return (
    <form className="card" onSubmit={submit}>
      <header className="card-head">
        <div>
          <h2>Add a candidate to a requisition</h2>
          <p>They start at Applied, and move on from there.</p>
        </div>
      </header>

      <div className="card-body form">
        <div className="form-row">
          <div className="field picker">
            <label className="field" htmlFor="candidate-search">
              Candidate
            </label>
            {picked === null ? (
              <>
                <div className="input-icon">
                  <Icon name="search" />
                  <input
                    id="candidate-search"
                    type="search"
                    placeholder="Search by name, email or phone"
                    value={draft}
                    maxLength={100}
                    onChange={(event) => setDraft(event.target.value)}
                    autoFocus
                  />
                </div>
                {found.error !== null ? (
                  <ErrorNotice error={found.error} onRetry={found.reload} />
                ) : (
                  <ul className="picker-results" aria-label="Matching candidates" aria-busy={found.loading}>
                    {found.data !== null && results.length === 0 ? (
                      <li className="empty">{q === '' ? 'No candidates on record.' : `Nobody matches “${q}”.`}</li>
                    ) : (
                      results.map((row) => (
                        <li key={row.id}>
                          <button type="button" aria-pressed={false} onClick={() => setPicked(row)}>
                            <Person name={row.name} meta={'email' in row ? row.email : undefined} />
                          </button>
                        </li>
                      ))
                    )}
                  </ul>
                )}
              </>
            ) : (
              <div className="demo-account selected">
                <Person name={picked.name} meta={'email' in picked ? picked.email : undefined} />
                <button type="button" className="link small" style={{ marginLeft: 'auto' }} onClick={() => setPicked(null)}>
                  Change
                </button>
              </div>
            )}
            {fieldErrors['body.candidateId'] !== undefined && (
              <span className="error">{fieldErrors['body.candidateId']}</span>
            )}
          </div>

          <label className="field">
            Requisition
            {openReqs.error !== null ? (
              <ErrorNotice error={openReqs.error} onRetry={openReqs.reload} />
            ) : (
              <select
                value={roleId}
                onChange={(event) => setRoleId(event.target.value)}
                disabled={openReqs.loading}
                required
              >
                <option value="">{openReqs.loading ? 'Loading…' : 'Choose an open requisition'}</option>
                {(openReqs.data ?? []).map((req) => (
                  <option key={req.id} value={req.id}>
                    {req.title}
                  </option>
                ))}
              </select>
            )}
            {fieldErrors['body.roleId'] !== undefined && (
              <span className="error">{fieldErrors['body.roleId']}</span>
            )}
          </label>
        </div>

        {error !== null &&
          (duplicate ? (
            <div className="notice info" role="status">
              <Icon name="check" />
              <span>{picked?.name ?? 'This candidate'} is already on that requisition.</span>
            </div>
          ) : (
            <ErrorNotice error={error} />
          ))}
      </div>

      <footer className="card-foot actions end">
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button type="submit" disabled={busy || candidateId === '' || roleId === ''}>
          {busy ? 'Adding…' : 'Add to requisition'}
        </button>
      </footer>
    </form>
  );
}
