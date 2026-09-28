import { Link } from 'react-router-dom';
import { myRounds } from '../api/client.js';
import type { Schemas } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { ErrorNotice, Loading } from '../components/Feedback.js';
import { RatingMark } from '../components/Rating.js';
import { DateTile, EmptyState, isPast, Icon, PageHeader, Person, StageBadge, relative } from '../components/ui.js';

/**
 * `GET /me/rounds` — the rounds this interviewer is assigned to, soonest first.
 *
 * The candidate arrives as `{ id, name }` and nothing else: the API strips contact
 * details on the interviewer path, so there is no column here to hide. This screen does
 * not re-decide that, it just renders what it was given.
 *
 * The req is identified by `roleId` only — the round view carries no title, and inventing
 * a second request to go and fetch one would hand an interviewer a list of open reqs they
 * are not otherwise entitled to. The stage is the useful context, so that is what shows.
 */


/**
 * How much of the panel has filed. Whether *you* have is deliberately not answered here:
 * it would need the feedback rows for every round in the list, and the one round you are
 * looking at answers it for free. See `RoundDetail`.
 */
function Panel({ round }: { round: Schemas['Round'] }) {
  if (round.feedbackCount === 0) {
    return <span className="muted small">No feedback yet</span>;
  }

  /**
   * Sorted, because the order the API returns them in carries no information — the nested
   * `feedback` select on the round has no `orderBy`, so it is whatever Postgres hands
   * back. Sorting makes a split panel read at a glance and stops the cell reshuffling
   * between refreshes.
   */
  const ratings = [...round.ratings].sort((a, b) => a - b);

  return (
    <span className="actions">
      <span className="marks">
        {ratings.map((rating, index) => (
          <RatingMark key={index} value={rating} />
        ))}
      </span>
      <span className="muted small">
        {round.feedbackCount} {round.feedbackCount === 1 ? 'response' : 'responses'}
      </span>
    </span>
  );
}

function RoundTable({ rows }: { rows: Schemas['Round'][] }) {
  return (
    <div className="scroll">
      <table className="grid list">
        <thead>
          <tr>
            <th>When</th>
            <th>Candidate</th>
            <th>Round</th>
            <th>Panel feedback</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((round) => {
            const at = new Date(round.scheduledAt);
            return (
              <tr key={round.id}>
                <td>
                  <span className="actions">
                    <DateTile iso={round.scheduledAt} />
                    <span className="round-when">
                      <strong>{at.toLocaleTimeString(undefined, { timeStyle: 'short' })}</strong>
                      <span className="muted small">{relative(round.scheduledAt)}</span>
                    </span>
                  </span>
                </td>
                <td>
                  <Person name={round.candidate.name} />
                </td>
                <td>
                  <StageBadge stage={round.stage} />
                </td>
                <td>
                  <Panel round={round} />
                </td>
                <td className="right">
                  <Link className="button sm secondary" to={`/rounds/${round.id}`}>
                    Open <Icon name="chevron" />
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function MyRounds() {
  const rounds = useApi(() => myRounds(), []);
  const all = rounds.data ?? [];
  const upcoming = all.filter((round) => !isPast(round.scheduledAt));
  // Most recent first: the one you just came out of is the one you are about to write up.
  const past = all.filter((round) => isPast(round.scheduledAt)).reverse();

  return (
    <div className="stack">
      <PageHeader title="My rounds" subtitle="Interviews you are on the panel for." />

      {rounds.loading ? (
        <section className="card">
          <Loading label="Loading rounds…" />
        </section>
      ) : rounds.error !== null ? (
        <ErrorNotice error={rounds.error} onRetry={rounds.reload} />
      ) : all.length === 0 ? (
        <section className="card">
          <EmptyState
            title="No interviews yet"
            hint="When a recruiter puts you on a panel, the round shows up here."
          />
        </section>
      ) : (
        <>
          <section className="card">
            <header className="card-head">
              <div>
                <h2>Upcoming</h2>
                <p>Soonest first.</p>
              </div>
            </header>
            {upcoming.length === 0 ? (
              <EmptyState title="Nothing scheduled" />
            ) : (
              <RoundTable rows={upcoming} />
            )}
          </section>

          {past.length > 0 && (
            <section className="card">
              <header className="card-head">
                <div>
                  <h2>Past</h2>
                  <p>Open a round to read the panel&rsquo;s feedback or add yours.</p>
                </div>
              </header>
              <RoundTable rows={past} />
            </section>
          )}
        </>
      )}
    </div>
  );
}
