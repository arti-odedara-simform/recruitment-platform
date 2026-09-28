import { candidate as fetchCandidate } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { ErrorNotice, Loading } from './Feedback.js';
import { formatDate } from './ui.js';

/**
 * Contact details, which exist on exactly one path: `GET /candidates/:id` as a recruiter.
 *
 * The API does not fetch a candidate and then decide what to keep — a recruiter's request
 * and an interviewer's request run *different SQL*, and the interviewer's statement does
 * not name `email` or `phone` at all. So the union this narrows on is not a formality:
 * `'email' in record` is the only thing that makes those fields readable here, and an
 * interviewer's response can never satisfy it.
 *
 * This component is rendered only for recruiters, which means the request is not made at
 * all for anyone else — the hiding is the absence of a call, not a hidden element.
 */
export function ContactCard({ candidateId }: { candidateId: string }) {
  const record = useApi(() => fetchCandidate(candidateId), [candidateId]);

  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h2>Contact</h2>
          <p>Visible to recruiters only.</p>
        </div>
      </header>

      {record.loading ? (
        <Loading label="Loading contact details…" />
      ) : record.error !== null ? (
        <ErrorNotice error={record.error} onRetry={record.reload} />
      ) : record.data === null ? null : 'email' in record.data ? (
        <dl className="contact">
          <div>
            <dt>Email</dt>
            <dd>
              <a href={`mailto:${record.data.email}`}>{record.data.email}</a>
            </dd>
          </div>
          <div>
            <dt>Phone</dt>
            <dd>
              {record.data.phone === null ? (
                <span className="muted">Not on file</span>
              ) : (
                <a href={`tel:${record.data.phone.replace(/\s+/g, '')}`}>{record.data.phone}</a>
              )}
            </dd>
          </div>
          <div>
            <dt>Added</dt>
            <dd className="muted">{formatDate(record.data.createdAt)}</dd>
          </div>
        </dl>
      ) : (
        /*
          Reachable only if this screen is ever rendered for an interviewer: the API
          answered with the narrow field set, and there is nothing to show.
        */
        <p className="muted pad">Contact details aren&rsquo;t available to your account.</p>
      )}
    </section>
  );
}
