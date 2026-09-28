import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, round as fetchRound, roundFeedback, submitFeedback } from '../api/client.js';
import type { Schemas } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { useSession } from '../auth/session.js';
import { ErrorNotice, Loading } from '../components/Feedback.js';
import { RATINGS, RatingPill } from '../components/Rating.js';
import { Avatar, DateTile, EmptyState, Icon, StageBadge, formatDateTime, relative } from '../components/ui.js';

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

const stamp = formatDateTime;

function Entry({ entry, mine }: { entry: Schemas['PeerFeedback']; mine: boolean }) {
  return (
    <li className={mine ? 'fb mine' : 'fb'}>
      <div className="fb-head">
        <Avatar name={entry.interviewer.name} size="sm" />
        <strong>{entry.interviewer.name}</strong>
        {mine && <span className="badge accent plain">You</span>}
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
        <div className="rating-options">
          {RATINGS.map((option) => (
            <label key={option.value} className={`chip r${option.value}`}>
              <input
                type="radio"
                name="rating"
                value={option.value}
                checked={rating === option.value}
                onChange={() => setRating(option.value)}
              />
              <span className="n">{option.value}</span>
              <span>{option.label}</span>
            </label>
          ))}
        </div>
        {fieldErrors['body.rating'] !== undefined && (
          <p className="error">{fieldErrors['body.rating']}</p>
        )}
      </fieldset>

      <label className="field">
        Notes
        <textarea
          rows={6}
          value={notes}
          maxLength={NOTES_MAX}
          placeholder="What you asked, how they approached it, and what it tells you about the role."
          onChange={(event) => setNotes(event.target.value)}
          required
        />
        <span className="hint count-hint">
          {trimmed.length} / {NOTES_MAX}
          {fieldErrors['body.notes'] !== undefined && (
            <span className="error"> — {fieldErrors['body.notes']}</span>
          )}
        </span>
      </label>

      {/* A 409 is handled above and the form is about to be replaced, so it is not shown
          as an error here; anything else is worth reading. */}
      {error !== null && !(error instanceof ApiError && error.status === 409) && (
        <ErrorNotice error={error} />
      )}

      <div className="actions">
        <button type="submit" disabled={!ready || busy}>
          {busy ? 'Submitting…' : 'Submit feedback'}
        </button>
        <span className="muted small">You can&rsquo;t edit feedback once it&rsquo;s submitted.</span>
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

  const r = round.data;
  const backLabel = user?.role === 'INTERVIEWER' ? 'My rounds' : 'Pipeline';

  return (
    <div className="stack">
      <div>
        {/*
          Home is `/` for every role, but it is not the same screen for every role, so
          the label follows the destination rather than assuming the reader is on the
          panel — a recruiter reaching a round detail goes back to the pipeline.
        */}
        <Link className="back" to="/">
          <Icon name="back" /> {backLabel}
        </Link>
        <section className="card">
          <div className="card-body hero">
            <DateTile iso={r.scheduledAt} />
            <div className="hero-text">
              <h1>
                {r.candidate.name}
              </h1>
              <div className="hero-meta">
                <StageBadge stage={r.stage} />
                <span>round</span>
                <span className="sep">•</span>
                <span>
                  {stamp(r.scheduledAt)} ({relative(r.scheduledAt)})
                </span>
              </div>
            </div>
            <span className="muted small" style={{ marginLeft: 'auto' }}>
              Candidate is currently at <StageBadge stage={r.currentStage} />
            </span>
          </div>
        </section>
      </div>

      <div className="layout-2">
        <div className="stack">
          {canSubmit && (
            <section className="card">
              <header className="card-head">
                <div>
                  <h2>Your feedback</h2>
                  <p>Your rating is recorded as you give it — it isn&rsquo;t combined with anyone else&rsquo;s.</p>
                </div>
              </header>
              <div className="card-body">
                <FeedbackForm roundId={id} onSubmitted={reloadAll} />
              </div>
            </section>
          )}

          {mine !== null && (
            <div className="notice ok" role="status">
              <Icon name="check" />
              <span>You submitted your feedback on {stamp(mine.submittedAt)}.</span>
            </div>
          )}

          <section className="card">
            <header className="card-head">
              <div>
                <h2>Panel feedback</h2>
                <p>In the order it was submitted.</p>
              </div>
              {entries.length > 0 && (
                <span className="muted small">
                  {entries.length} {entries.length === 1 ? 'response' : 'responses'}
                </span>
              )}
            </header>

            {panel.loading ? (
              <Loading label="Loading feedback…" />
            ) : panel.error !== null ? (
              <ErrorNotice error={panel.error} onRetry={panel.reload} />
            ) : entries.length === 0 ? (
              <EmptyState title="No feedback yet" hint="Responses appear here as the panel submits them." />
            ) : (
              <ul className="fb-list">
                {entries.map((entry) => (
                  <Entry key={entry.id} entry={entry} mine={entry.interviewerId === user?.id} />
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="card">
          <header className="card-head">
            <h2>How ratings work</h2>
          </header>
          <div className="card-body stack">
            <ul className="side-list" style={{ margin: '-20px -20px 0' }}>
              {RATINGS.map((option) => (
                <li key={option.value}>
                  <span>
                    <RatingPill value={option.value} />
                  </span>
                  <span className="muted small">{option.value} of 4</span>
                </li>
              ))}
            </ul>
            <p className="muted small">
              There&rsquo;s no neutral option — every rating is a lean one way or the other.
              Feedback doesn&rsquo;t move the candidate on its own; the recruiter decides.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
