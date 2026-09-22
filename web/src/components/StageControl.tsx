import { useState } from 'react';
import { ApiError, advanceStage, overrideStage } from '../api/client.js';
import { ErrorNotice } from './Feedback.js';
import { ALLOWED, isTerminal, overrideTargets, type Stage } from '../domain/stages.js';

/**
 * The two ways an application moves, side by side and deliberately not alike.
 *
 * An **advance** is one step along the stage machine, so it is a button per legal move
 * and nothing to fill in. An **override** skips stages, so it is a form: a target, and a
 * reason of at least ten characters that the API refuses without and a `CHECK` constraint
 * refuses underneath that. The reason is not a courtesy — it is the record of why the
 * pipeline was stepped around, and it is what `GET /audit/candidates/:id` reads back.
 *
 * Feedback never moves either of these. Ratings are recorded; a recruiter advances.
 */

/** The API's floor, mirrored so the button can be disabled before the round trip. */
const MIN_REASON = 10;

interface Props {
  candidateId: string;
  roleId: string;
  currentStage: Stage;
  /** Refetch after a move: the stage, the timeline and the round views all just changed. */
  onChanged: () => void;
}

/**
 * A 422 carries `from`, `to` and the legal `allowed` set as problem extensions — the
 * stage machine explaining itself rather than merely refusing. Worth rendering: if this
 * screen's copy of the table has drifted from the server's, this is the line that says so.
 */
function allowedFrom(error: ApiError | Error | null): string[] | null {
  if (!(error instanceof ApiError) || error.status !== 422) return null;
  const allowed = (error.problem as { allowed?: unknown } | null)?.allowed;
  return Array.isArray(allowed) ? allowed.map(String) : null;
}

export function StageControl({ candidateId, roleId, currentStage, onChanged }: Props) {
  const [busy, setBusy] = useState<Stage | 'override' | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [overriding, setOverriding] = useState(false);
  const [target, setTarget] = useState<Stage | ''>('');
  const [reason, setReason] = useState('');

  const advances = ALLOWED[currentStage];
  const targets = overrideTargets(currentStage);
  const trimmedReason = reason.trim();
  const refused = allowedFrom(error);

  async function run(label: Stage | 'override', action: () => Promise<unknown>) {
    if (busy !== null) return;
    setBusy(label);
    setError(null);

    try {
      await action();
      setOverriding(false);
      setReason('');
      setTarget('');
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stage-control">
      {isTerminal(currentStage) ? (
        <p className="muted">
          {currentStage} is terminal. Nothing moves out of it — not an advance, and not an
          override. Reopening is a different act with its own record, and this API does not
          have it yet.
        </p>
      ) : (
        <>
          <div className="actions">
            {advances.map((stage) => (
              <button
                key={stage}
                type="button"
                className={stage === 'REJECTED' ? 'danger' : ''}
                disabled={busy !== null}
                onClick={() => run(stage, () => advanceStage(candidateId, roleId, stage))}
              >
                {busy === stage ? 'Moving…' : `Advance to ${stage}`}
              </button>
            ))}
            <button
              type="button"
              className="link"
              disabled={busy !== null}
              onClick={() => setOverriding((open) => !open)}
            >
              {overriding ? 'Cancel override' : 'Override the stage instead'}
            </button>
          </div>

          {overriding && (
            <form
              className="override"
              onSubmit={(event) => {
                event.preventDefault();
                if (target === '' || trimmedReason.length < MIN_REASON) return;
                void run('override', () =>
                  overrideStage(candidateId, roleId, target, trimmedReason),
                );
              }}
            >
              <p className="muted">
                An override skips the machine — {currentStage} straight to wherever this
                says. It is recorded as an OVERRIDE with your reason attached, in the same
                transaction as the move, and it shows up in the candidate&rsquo;s timeline
                as one.
              </p>

              <label>
                Move to
                <select
                  value={target}
                  onChange={(event) => setTarget(event.target.value as Stage)}
                  required
                >
                  <option value="">Choose a stage…</option>
                  {targets.map((stage) => (
                    <option key={stage} value={stage}>
                      {stage}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Reason
                <textarea
                  rows={3}
                  value={reason}
                  maxLength={1000}
                  placeholder="Why the usual sequence is being stepped around."
                  onChange={(event) => setReason(event.target.value)}
                  required
                />
              </label>
              <p className="muted count-hint">
                {trimmedReason.length} / 1000 — at least {MIN_REASON} characters, enforced by
                the API and by the database.
              </p>

              <div className="actions">
                <button
                  type="submit"
                  disabled={busy !== null || target === '' || trimmedReason.length < MIN_REASON}
                >
                  {busy === 'override' ? 'Recording…' : 'Record override'}
                </button>
              </div>
            </form>
          )}
        </>
      )}

      {error !== null && (
        <div className="stage-error">
          <ErrorNotice error={error} />
          {refused !== null && (
            <p className="muted pad">
              The stage machine allows{' '}
              {refused.length === 0 ? 'nothing from here' : refused.join(', ')}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
