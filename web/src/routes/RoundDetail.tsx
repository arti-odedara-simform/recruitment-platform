import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, round as fetchRound, roundFeedback, submitFeedback } from '../api/client.js';
import type { Schemas } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { useSession } from '../auth/session.js';
import { ErrorNotice, Loading } from '../components/Feedback.js';
import { RATINGS, RatingPill } from '../components/Rating.js';

/**
 * One round: what it is, what the panel said, and — for an assigned interviewer who has
 * not filed yet — the form that says it.
 *
 * Two requests, not one. `GET /rounds/:id` gives the round and a derived `feedbackCount`;
 * `GET /rounds/:id/feedback` gives the rows. The second is what answers "have *I*
 * submitted", by looking for the caller's own id among the interviewers — the API has no
 * endpoint that asks that question, and it does not need one.
 *
 * PLAN.md §4 reads the brief's "interviewers can't see prior feedback before their round"
 * as the *problem*, so peer feedback is visible to anyone assigned. That decision is the
 * API's; this screen shows what it returns rather than re-imposing a rule on top.
 */

const NOTES_MAX = 5000;

function stamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function Entry({ entry, mine }: { entry: Schemas['PeerFeedback']; mine: boolean }) {
  return (
    <li className={mine ? 'fb mine' : 'fb'}>
      <div className="fb-head">
        <strong>{entry.interviewer.name}</strong>
        {mine && <span className="pill role">You</span>}
        <RatingPill value={entry.rating} />
        <span className="muted when">{stamp(entry.submittedAt)}</span>
      </div>
      <p className="fb-notes">{entry.notes}</p>
    </li>
  );
}

function FeedbackForm({ roundId, onSubmitted }: { roundId: string; onSubmitted: () => void }) {
  const [rating, setRating] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [busy, setBusy] = useState(false);

  const fieldErrors = error instanceof ApiError ? error.fieldErrors : {};
  const trimmed = notes.trim();
  const ready = rating !== null && trimmed.length > 0 && trimmed.length <= NOTES_MAX;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;

    setBusy(true);
    setError(null);

    try {
      // `notes` is sent trimmed because that is what the API validates — sending the raw
      // value would fail min(1) on whitespace the user cannot see.
      await submitFeedback(roundId, { rating, notes: trimmed });
      onSubmitted();
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));

      /**
       * 409 means the unique index caught a second submission — a duplicate tab, or a
       * double-click that outran `busy`. The row it collided with is this interviewer's
       * own, so refetching replaces this form with that row: the screen ends up correct
       * rather than merely apologetic.
       */
      if (cause instanceof ApiError && cause.status === 409) {
        onSubmitted();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="fb-form" onSubmit={submit}>
      <fieldset className="rating-set">
        <legend>Your rating</legend>
        <div className="rating">
          {RATINGS.map((option) => (
            <label key={option.value} className="chip">
              <input
                type="radio"
                name="rating"
                value={option.value}
                checked={rating === option.value}
                onChange={() => setRating(option.value)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
        {fieldErrors['body.rating'] !== undefined && (
          <p className="error">{fieldErrors['body.rating']}</p>
        )}
      </fieldset>

      <label>
        Notes
        <textarea
          rows={6}
          value={notes}
          maxLength={NOTES_MAX}
          placeholder="What you asked, what they did, and what it tells you."
          onChange={(event) => setNotes(event.target.value)}
          required
        />
      </label>
      <p className="muted count-hint">
        {trimmed.length} / {NOTES_MAX}
        {fieldErrors['body.notes'] !== undefined && (
          <span className="error"> — {fieldErrors['body.notes']}</span>
        )}
      </p>

      {/* A 409 is handled above and the form is about to be replaced, so it is not shown
          as an error here; anything else is worth reading. */}
      {error !== null && !(error instanceof ApiError && error.status === 409) && (
        <ErrorNotice error={error} />
      )}

      <div className="actions">
        <button type="submit" disabled={!ready || busy}>
          {busy ? 'Submitting…' : 'Submit feedback'}
        </button>
        <span className="muted">
          One submission per interviewer per round — it cannot be edited afterwards.
        </span>
      </div>
    </form>
  );
}

export function RoundDetail() {
  const { id = '' } = useParams<{ id: string }>();
  const { user } = useSession();

  const round = useApi(() => fetchRound(id), [id]);
  const panel = useApi(() => roundFeedback(id), [id]);

  if (round.loading) return <Loading label="Loading round…" />;
  if (round.error !== null) return <ErrorNotice error={round.error} onRetry={round.reload} />;
  if (round.data === null) return <Loading label="Loading round…" />;

  const entries = panel.data ?? [];
  const mine = entries.find((entry) => entry.interviewerId === user?.id) ?? null;

  // Only interviewers may submit, and only once. Until the panel list has loaded there is
  // no way to know which — so the form waits rather than flashing into view and out again.
  const canSubmit = user?.role === 'INTERVIEWER' && panel.data !== null && mine === null;

  function reloadAll() {
    panel.reload();
    round.reload();
  }

  return (
    <div className="stack">
      <section className="card">
        <header className="card-head row">
          <div>
            <h2>{round.data.candidate.name}</h2>
            <p className="muted">
              {round.data.stage} round · scheduled {stamp(round.data.scheduledAt)} · the
              application is in {round.data.currentStage}
            </p>
          </div>
          {/*
            Home is `/` for every role, but it is not the same screen for every role, so
            the label follows the destination rather than assuming the reader is on the
            panel — a recruiter reaching a round detail goes back to the pipeline.
          */}
          <Link className="go" to="/">
            ← {user?.role === 'INTERVIEWER' ? 'My rounds' : 'Pipeline'}
          </Link>
        </header>

        <p className="muted pad">
          Feedback never moves an application on its own — a recruiter advances the stage,
          explicitly. Ratings here are recorded, not tallied into a verdict.
        </p>
      </section>

      <section className="card">
        <header className="card-head">
          <h2>Panel feedback</h2>
          <p className="muted">
            Everyone assigned to this round, oldest first. Submissions are never merged and
            never overwritten.
          </p>
        </header>

        {panel.loading ? (
          <Loading label="Loading feedback…" />
        ) : panel.error !== null ? (
          <ErrorNotice error={panel.error} onRetry={panel.reload} />
        ) : entries.length === 0 ? (
          <p className="muted pad">Nobody has submitted yet.</p>
        ) : (
          <ul className="fb-list">
            {entries.map((entry) => (
              <Entry key={entry.id} entry={entry} mine={entry.interviewerId === user?.id} />
            ))}
          </ul>
        )}
      </section>

      {canSubmit && (
        <section className="card">
          <header className="card-head">
            <h2>Your feedback</h2>
            <p className="muted">
              Yours alone — submitting does not overwrite or merge with anyone else&rsquo;s.
            </p>
          </header>
          <div className="pad">
            <FeedbackForm roundId={id} onSubmitted={reloadAll} />
          </div>
        </section>
      )}

      {mine !== null && (
        <p className="muted pad">
          You submitted on {stamp(mine.submittedAt)}. A second submission for the same round
          is rejected by the database, not silently applied.
        </p>
      )}
    </div>
  );
}
