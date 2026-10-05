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
import { useApi, type AsyncState } from '../api/useApi.js';
import { ErrorNotice, Loading } from './Feedback.js';
import { RatingMark } from './Rating.js';
import { Avatar, DateTile, EmptyState, Icon, StageBadge, formatDateTime, relative } from './ui.js';
import { STAGES, stageLabel, type Stage } from '../domain/stages.js';

/**
 * The stages an interview is held for. The API accepts any stage and does not check it
 * against the application's; the picker offers the ones a recruiter would actually book.
 */
const ROUND_STAGES: readonly Stage[] = ['SCREEN', 'INTERVIEW', 'OFFER'];

/**
 * Rounds for one application, and the two recruiter actions on them: schedule one, and
 * put an interviewer on it.
 *
 * Assigning is the call that *creates* an interviewer's access to a candidate — it is why
 * `GET /candidates/:id` and `GET /rounds/:id` return anything at all on the interviewer
 * path. So this panel shows who is already on a round before it offers to add anyone: the
 * roster arrives on the recruiter's round view and nowhere else.
 */

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
    return <p className="muted small">Everyone available is already on this panel.</p>;
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
      <label>
        <span className="sr-only">Interviewer</span>
        <select
          value={interviewerId}
          onChange={(event) => setInterviewerId(event.target.value)}
          disabled={busy}
        >
          <option value="">Add an interviewer…</option>
          {available.map((user) => (
            <option key={user.id} value={user.id}>
              {user.name}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="secondary" disabled={busy || interviewerId === ''}>
        {busy ? 'Adding…' : 'Add to panel'}
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
  // A round is booked for a stage still ahead; a terminal application defaults to the loop.
  const [stage, setStage] = useState<Stage>(ROUND_STAGES.includes(currentStage) ? currentStage : 'INTERVIEW');
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
      <label className="field">
        Round type
        <select value={stage} onChange={(event) => setStage(event.target.value as Stage)}>
          {ROUND_STAGES.map((option) => (
            <option key={option} value={option}>
              {stageLabel(option)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Date and time
        <input type="datetime-local" value={at} onChange={(event) => setAt(event.target.value)} required />
      </label>
      <button type="submit" disabled={busy}>
        <Icon name="calendar" /> {busy ? 'Scheduling…' : 'Schedule'}
      </button>
      {error !== null && (
        <div style={{ flexBasis: '100%' }}>
          <ErrorNotice error={error} />
        </div>
      )}
    </form>
  );
}

/**
 * A round is "earlier" once the application has moved past its stage — an Interview round
 * after the move to Offer, or any round once the application is Hired or Rejected. Those
 * stay on record (their feedback is the reason for the move) but are no longer the
 * schedule, so they are listed apart and without the panel picker.
 */
function isEarlier(roundStage: string, currentStage: Stage): boolean {
  if (currentStage === 'HIRED' || currentStage === 'REJECTED') return true;
  return STAGES.indexOf(roundStage as Stage) < STAGES.indexOf(currentStage);
}

function RoundItem({
  round,
  interviewers,
  onAssigned,
}: {
  round: Schemas['Round'];
  /** `null` renders the round read-only: no one is added to a stage the candidate has left. */
  interviewers: AsyncState<Schemas['PublicUser'][]> | null;
  onAssigned: () => void;
}) {
  return (
    <li className="round">
      <div className="round-head">
        <DateTile iso={round.scheduledAt} />
        <span className="round-when">
          <strong>{formatDateTime(round.scheduledAt)}</strong>
          <span className="muted small">{relative(round.scheduledAt)}</span>
        </span>
        <StageBadge stage={round.stage} />
        <span className="spacer" />
        {round.feedbackCount === 0 ? (
          <span className="muted small">No feedback yet</span>
        ) : (
          <span className="marks">
            {[...round.ratings]
              .sort((a, b) => a - b)
              .map((rating, index) => (
                <RatingMark key={index} value={rating} />
              ))}
          </span>
        )}
        <Link className="button sm secondary" to={`/rounds/${round.id}`}>
          View <Icon name="chevron" />
        </Link>
      </div>

      <div className="chips">
        {(round.assignments ?? []).length === 0 ? (
          <span className="badge warn plain">No interviewers yet</span>
        ) : (
          (round.assignments ?? []).map((entry) => (
            <span
              key={entry.interviewer.id}
              className="person-chip"
              title={`Added by ${entry.assignedBy.name}`}
            >
              <Avatar name={entry.interviewer.name} size="sm" />
              {entry.interviewer.name}
            </span>
          ))
        )}
      </div>

      {interviewers === null ? null : interviewers.error !== null ? (
        <ErrorNotice error={interviewers.error} onRetry={interviewers.reload} />
      ) : (
        interviewers.data !== null && (
          <AssignForm round={round} interviewers={interviewers.data} onAssigned={onAssigned} />
        )
      )}
    </li>
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

  const all = rounds.data ?? [];
  const list = all.filter((round) => !isEarlier(round.stage, currentStage));
  const earlier = all.filter((round) => isEarlier(round.stage, currentStage));

  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h2>Interview rounds</h2>
          <p>Interviewers only see this candidate once they are on a round&rsquo;s panel.</p>
        </div>
      </header>

      {rounds.loading ? (
        <Loading label="Loading rounds…" />
      ) : rounds.error !== null ? (
        <ErrorNotice error={rounds.error} onRetry={rounds.reload} />
      ) : list.length === 0 ? (
        <EmptyState
          title={`No ${stageLabel(currentStage).toLowerCase()} rounds scheduled`}
          hint="Schedule one below."
        />
      ) : (
        <ul className="rounds">
          {list.map((round) => (
            <RoundItem key={round.id} round={round} interviewers={interviewers} onAssigned={reload} />
          ))}
        </ul>
      )}

      {!rounds.loading && rounds.error === null && earlier.length > 0 && (
        <details className="earlier-rounds">
          <summary>
            Earlier rounds <span className="muted">({earlier.length})</span>
          </summary>
          <ul className="rounds">
            {earlier.map((round) => (
              <RoundItem key={round.id} round={round} interviewers={null} onAssigned={reload} />
            ))}
          </ul>
        </details>
      )}

      <div className="card-foot">
        <h3 style={{ marginBottom: 10 }}>Schedule a round</h3>
        <ScheduleForm
          key={currentStage}
          candidateId={candidateId}
          roleId={roleId}
          currentStage={currentStage}
          onScheduled={reload}
        />
      </div>
    </section>
  );
}
