import { useState } from 'react';
import { ApiError, advanceStage, overrideStage } from '../api/client.js';
import { ErrorNotice } from './Feedback.js';
import { Icon } from './ui.js';
import { ALLOWED, isTerminal, overrideTargets, stageLabel, type Stage } from '../domain/stages.js';

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

  const forward = advances.filter((stage) => stage !== 'REJECTED');
  const canReject = advances.includes('REJECTED');

  return (
    <div className="stage-control">
      {isTerminal(currentStage) ? (
        <div className={currentStage === 'HIRED' ? 'notice ok' : 'notice info'}>
          <Icon name={currentStage === 'HIRED' ? 'check' : 'flag'} />
          <span>
            {currentStage === 'HIRED'
              ? 'Hired — this application is complete.'
              : 'Rejected — this application is closed.'}{' '}
            Its stage can no longer be changed.
          </span>
        </div>
      ) : (
        <>
          <div className="actions">
            {forward.map((stage) => (
              <button
                key={stage}
                type="button"
                disabled={busy !== null}
                onClick={() => run(stage, () => advanceStage(candidateId, roleId, stage))}
              >
                {busy === stage ? 'Moving…' : `Move to ${stageLabel(stage)}`}
                {busy !== stage && <Icon name="arrow" />}
              </button>
            ))}
            {canReject && (
              <button
                type="button"
                className="danger"
                disabled={busy !== null}
                onClick={() => run('REJECTED', () => advanceStage(candidateId, roleId, 'REJECTED'))}
              >
                {busy === 'REJECTED' ? 'Rejecting…' : 'Reject'}
              </button>
            )}
            <button
              type="button"
              className="ghost"
              style={{ marginLeft: 'auto' }}
              disabled={busy !== null}
              onClick={() => setOverriding((open) => !open)}
              aria-expanded={overriding}
            >
              {overriding ? 'Cancel' : 'Skip to another stage…'}
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
              <div>
                <h3>Skip the usual order</h3>
                <p className="muted small">
                  This moves the candidate straight from {stageLabel(currentStage)} to the stage
                  you pick. It&rsquo;s marked as an override in the activity history, with your
                  reason.
                </p>
              </div>

              <label className="field">
                Move to
                <select
                  value={target}
                  onChange={(event) => setTarget(event.target.value as Stage)}
                  required
                >
                  <option value="">Choose a stage</option>
                  {targets.map((stage) => (
                    <option key={stage} value={stage}>
                      {stageLabel(stage)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                Reason
                <textarea
                  rows={3}
                  value={reason}
                  maxLength={1000}
                  placeholder="e.g. Strong referral — team agreed to skip the phone screen."
                  onChange={(event) => setReason(event.target.value)}
                  required
                />
                <span className="hint">
                  {trimmedReason.length < MIN_REASON
                    ? `At least ${MIN_REASON} characters.`
                    : `${trimmedReason.length} / 1000`}
                </span>
              </label>

              <div className="actions end">
                <button
                  type="submit"
                  disabled={busy !== null || target === '' || trimmedReason.length < MIN_REASON}
                >
                  {busy === 'override' ? 'Saving…' : 'Move candidate'}
                </button>
              </div>
            </form>
          )}
        </>
      )}

      {error !== null && (
        <div className="stack">
          <ErrorNotice error={error} />
          {refused !== null && (
            <p className="muted small">
              From here the candidate can move to{' '}
              {refused.length === 0 ? 'no other stage' : refused.map(stageLabel).join(' or ')}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
