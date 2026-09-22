import { useMemo, useState } from 'react';
import { ApiError, applications, createApplication, roles } from '../api/client.js';
import type { Schemas } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { ErrorNotice } from './Feedback.js';

/**
 * Putting a candidate onto a req.
 *
 * Only OPEN reqs are offered: the API refuses a closed one with a 400 from inside the
 * transaction, and a picker that lists reqs a recruiter cannot use is a picker that
 * teaches them to ignore its errors.
 *
 * The candidate side is honest about a gap rather than papering over it. This API has no
 * candidate directory — `GET /candidates/:id` reads one record and nothing lists them —
 * so the names offered here are the candidates already on some req, gathered from
 * `GET /applications`. Someone brand new to the system is reachable only by id, which is
 * what the free-text option is for, and not a hidden limitation.
 */

/** The sentinel that swaps the picker for a raw id field; not a candidate id. */
const BY_ID = 'by-id';

function directory(rows: Schemas['ApplicationListItem'][]): Array<{ id: string; name: string }> {
  const byId = new Map(rows.map((row) => [row.candidate.id, row.candidate]));
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function AddToReqForm({
  onAdded,
}: {
  /** Refetch: the new row belongs in the list this form sits under. */
  onAdded: () => void;
}) {
  // Deliberately unfiltered by the screen's own filters — the pool of candidates a
  // recruiter can reach should not shrink because they are looking at one req.
  const known = useApi(() => applications({ roleStatus: 'ALL' }), []);
  const openReqs = useApi(() => roles('OPEN'), []);

  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState('');
  const [typedId, setTypedId] = useState('');
  const [roleId, setRoleId] = useState('');
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [busy, setBusy] = useState(false);

  const candidates = useMemo(() => directory(known.data ?? []), [known.data]);
  const candidateId = choice === BY_ID ? typedId.trim() : choice;
  const fieldErrors = error instanceof ApiError ? error.fieldErrors : {};
  const duplicate = error instanceof ApiError && error.status === 409;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || candidateId === '' || roleId === '') return;

    setBusy(true);
    setError(null);

    try {
      await createApplication({ candidateId, roleId });
      setChoice('');
      setTypedId('');
      setRoleId('');
      setOpen(false);
      onAdded();
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

  if (!open) {
    return (
      <div className="pad bordered">
        <button type="button" onClick={() => setOpen(true)}>
          Put a candidate on a req
        </button>
      </div>
    );
  }

  return (
    <form className="pad bordered create" onSubmit={submit}>
      <p className="muted">
        The application starts at APPLIED — there is no stage to choose here, because every
        move after this one belongs to the stage machine.
      </p>

      <div className="create-fields">
        <label>
          Candidate
          {known.error !== null ? (
            <ErrorNotice error={known.error} onRetry={known.reload} />
          ) : (
            <select
              value={choice}
              onChange={(event) => setChoice(event.target.value)}
              disabled={known.loading}
              required
            >
              <option value="">{known.loading ? 'Loading…' : 'Choose a candidate…'}</option>
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
              <option value={BY_ID}>Someone else — by id…</option>
            </select>
          )}
          {fieldErrors['body.candidateId'] !== undefined && (
            <span className="error">{fieldErrors['body.candidateId']}</span>
          )}
        </label>

        {choice === BY_ID && (
          <label>
            Candidate id
            <input
              type="text"
              value={typedId}
              placeholder="00000000-0000-0000-0000-000000000000"
              onChange={(event) => setTypedId(event.target.value)}
              required
            />
            <span className="muted">
              The names above are candidates already on a req — this API has nothing that
              lists the rest. An unknown id is refused by the foreign key, as a 404.
            </span>
          </label>
        )}

        <label>
          Req
          {openReqs.error !== null ? (
            <ErrorNotice error={openReqs.error} onRetry={openReqs.reload} />
          ) : (
            <select
              value={roleId}
              onChange={(event) => setRoleId(event.target.value)}
              disabled={openReqs.loading}
              required
            >
              <option value="">{openReqs.loading ? 'Loading…' : 'Choose an open req…'}</option>
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

      <div className="actions">
        <button type="submit" disabled={busy || candidateId === '' || roleId === ''}>
          {busy ? 'Adding…' : 'Add to req'}
        </button>
        <button type="button" className="link" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>

      {error !== null && (
        <div className="stage-error">
          <ErrorNotice error={error} />
          {duplicate && (
            <p className="muted pad">
              Already on that req — the list below has been refetched, so the row is there.
            </p>
          )}
        </div>
      )}
    </form>
  );
}
