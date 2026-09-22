import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ApiError,
  applicationRounds,
  assignInterviewer,
  createRound,
  users,
} from '../api/client.js';
import type { Schemas } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { ErrorNotice, Loading } from './Feedback.js';
import { RatingMark } from './Rating.js';
import { STAGES, type Stage } from '../domain/stages.js';

/**
 * Rounds for one application, and the two recruiter actions on them: schedule one, and
 * put an interviewer on it.
 *
 * Assigning is the call that *creates* an interviewer's access to a candidate — it is why
 * `GET /candidates/:id` and `GET /rounds/:id` return anything at all on the interviewer
 * path. So this panel shows who is already on a round before it offers to add anyone: the
 * roster arrives on the recruiter's round view and nowhere else.
 */

function stamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** `datetime-local` speaks local wall-clock time; the API takes an ISO instant. */
function toLocalInputValue(at: Date): string {
  const offset = at.getTimezoneOffset() * 60_000;
  return new Date(at.getTime() - offset).toISOString().slice(0, 16);
}

function AssignForm({
  round,
  interviewers,
  onAssigned,
}: {
  round: Schemas['Round'];
  interviewers: Schemas['PublicUser'][];
  onAssigned: () => void;
}) {
  const [interviewerId, setInterviewerId] = useState('');
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [busy, setBusy] = useState(false);

  const assigned = new Set((round.assignments ?? []).map((entry) => entry.interviewer.id));
  const available = interviewers.filter((user) => !assigned.has(user.id));

  if (available.length === 0) {
    return <p className="muted">Every interviewer is already on this round.</p>;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (interviewerId === '' || busy) return;

    setBusy(true);
    setError(null);

    try {
      await assignInterviewer(round.id, interviewerId);
      setInterviewerId('');
      onAssigned();
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));

      /**
       * 409 is the composite primary key saying this interviewer is already on the round
       * — a duplicate tab, or a double-click that outran `busy`. Refetching replaces the
       * picker with the roster that already contains them, which ends up correct rather
       * than merely apologetic. Same argument as the feedback form.
       */
      if (cause instanceof ApiError && cause.status === 409) {
        onAssigned();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="assign" onSubmit={submit}>
      <label className="inline">
        Assign
        <select
          value={interviewerId}
          onChange={(event) => setInterviewerId(event.target.value)}
          disabled={busy}
        >
          <option value="">Choose an interviewer…</option>
          {available.map((user) => (
            <option key={user.id} value={user.id}>
              {user.name}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={busy || interviewerId === ''}>
        {busy ? 'Assigning…' : 'Assign'}
      </button>
      {error !== null && !(error instanceof ApiError && error.status === 409) && (
        <ErrorNotice error={error} />
      )}
    </form>
  );
}

function ScheduleForm({
  candidateId,
  roleId,
  currentStage,
  onScheduled,
}: {
  candidateId: string;
  roleId: string;
  currentStage: Stage;
  onScheduled: () => void;
}) {
  const [stage, setStage] = useState<Stage>(currentStage);
  const [at, setAt] = useState(() => toLocalInputValue(new Date(Date.now() + 86_400_000)));
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || at === '') return;

    setBusy(true);
    setError(null);

    try {
      await createRound({
        candidateId,
        roleId,
        stage,
        scheduledAt: new Date(at).toISOString(),
      });
      onScheduled();
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="schedule" onSubmit={submit}>
      <label className="inline">
        Stage
        <select value={stage} onChange={(event) => setStage(event.target.value as Stage)}>
          {STAGES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <label className="inline">
        When
        <input type="datetime-local" value={at} onChange={(event) => setAt(event.target.value)} required />
      </label>
      <button type="submit" disabled={busy}>
        {busy ? 'Scheduling…' : 'Schedule round'}
      </button>
      {error !== null && <ErrorNotice error={error} />}
    </form>
  );
}

export function RoundsPanel({
  candidateId,
  roleId,
  currentStage,
}: {
  candidateId: string;
  roleId: string;
  currentStage: Stage;
}) {
  const rounds = useApi(() => applicationRounds(candidateId, roleId), [candidateId, roleId]);
  const interviewers = useApi(() => users('INTERVIEWER'), []);

  function reload() {
    rounds.reload();
  }

  return (
    <section className="card">
      <header className="card-head">
        <h2>Rounds</h2>
        <p className="muted">
          A round&rsquo;s stage is not checked against the application&rsquo;s — booking an
          interview loop while a candidate is still in SCREEN is ordinary recruiting.
          Assigning an interviewer is what gives them sight of this candidate at all.
        </p>
      </header>

      {rounds.loading ? (
        <Loading label="Loading rounds…" />
      ) : rounds.error !== null ? (
        <ErrorNotice error={rounds.error} onRetry={rounds.reload} />
      ) : (rounds.data ?? []).length === 0 ? (
        <p className="muted pad">No rounds scheduled yet.</p>
      ) : (
        <ul className="rounds">
          {(rounds.data ?? []).map((round) => (
            <li key={round.id} className="round">
              <div className="round-head">
                <span className="pill">{round.stage}</span>
                <strong>{stamp(round.scheduledAt)}</strong>
                {round.feedbackCount === 0 ? (
                  <span className="muted">No feedback yet</span>
                ) : (
                  <span className="marks">
                    {[...round.ratings]
                      .sort((a, b) => a - b)
                      .map((rating, index) => (
                        <RatingMark key={index} value={rating} />
                      ))}
                  </span>
                )}
                <Link className="go" to={`/rounds/${round.id}`}>
                  Open
                </Link>
              </div>

              <div className="panel-list">
                {(round.assignments ?? []).length === 0 ? (
                  <span className="muted">Nobody assigned — this round is invisible to every interviewer.</span>
                ) : (
                  (round.assignments ?? []).map((entry) => (
                    <span key={entry.interviewer.id} className="pill" title={`assigned by ${entry.assignedBy.name}`}>
                      {entry.interviewer.name}
                    </span>
                  ))
                )}
              </div>

              {interviewers.error !== null ? (
                <ErrorNotice error={interviewers.error} onRetry={interviewers.reload} />
              ) : (
                interviewers.data !== null && (
                  <AssignForm round={round} interviewers={interviewers.data} onAssigned={reload} />
                )
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="pad bordered">
        <ScheduleForm
          candidateId={candidateId}
          roleId={roleId}
          currentStage={currentStage}
          onScheduled={reload}
        />
      </div>
    </section>
  );
}
