import { Link } from 'react-router-dom';
import { myRounds } from '../api/client.js';
import type { Schemas } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { ErrorNotice, Loading } from '../components/Feedback.js';
import { RatingMark } from '../components/Rating.js';

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

function scheduled(iso: string): { label: string; past: boolean } {
  const at = new Date(iso);
  return {
    label: at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    past: at.getTime() < Date.now(),
  };
}

/**
 * How much of the panel has filed. Whether *you* have is deliberately not answered here:
 * it would need the feedback rows for every round in the list, and the one round you are
 * looking at answers it for free. See `RoundDetail`.
 */
function Panel({ round }: { round: Schemas['Round'] }) {
  if (round.feedbackCount === 0) {
    return <span className="muted">None yet</span>;
  }

  /**
   * Sorted, because the order the API returns them in carries no information — the nested
   * `feedback` select on the round has no `orderBy`, so it is whatever Postgres hands
   * back. Sorting makes a split panel read at a glance and stops the cell reshuffling
   * between refreshes.
   */
  const ratings = [...round.ratings].sort((a, b) => a - b);

  return (
    <span>
      <span className="marks">
        {ratings.map((rating, index) => (
          <RatingMark key={index} value={rating} />
        ))}
      </span>
      <span className="age">{round.feedbackCount} submitted</span>
    </span>
  );
}

export function MyRounds() {
  const rounds = useApi(() => myRounds(), []);

  return (
    <section className="card">
      <header className="card-head">
        <h2>My rounds</h2>
        <p className="muted">
          Interviews you are assigned to. The list is scoped by the route itself — there is
          no parameter that could widen it to another interviewer.
        </p>
      </header>

      {rounds.loading ? (
        <Loading label="Loading rounds…" />
      ) : rounds.error !== null ? (
        <ErrorNotice error={rounds.error} onRetry={rounds.reload} />
      ) : (rounds.data ?? []).length === 0 ? (
        <p className="muted pad">No rounds assigned to you.</p>
      ) : (
        <table className="grid list">
          <thead>
            <tr>
              <th>Candidate</th>
              <th>Round</th>
              <th>Application</th>
              <th>Scheduled</th>
              <th>Panel</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(rounds.data ?? []).map((round) => {
              const at = scheduled(round.scheduledAt);
              return (
                <tr key={round.id}>
                  <td>{round.candidate.name}</td>
                  <td>
                    <span className="pill">{round.stage}</span>
                  </td>
                  <td className="muted">{round.currentStage}</td>
                  <td className={at.past ? 'muted' : ''}>{at.label}</td>
                  <td>
                    <Panel round={round} />
                  </td>
                  <td>
                    <Link className="go" to={`/rounds/${round.id}`}>
                      Open
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
