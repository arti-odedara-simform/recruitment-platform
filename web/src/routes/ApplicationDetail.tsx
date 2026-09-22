import { Link, useParams } from 'react-router-dom';
import { candidateAudit } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { useSession } from '../auth/session.js';
import { ContactCard } from '../components/ContactCard.js';
import { ErrorNotice, Loading } from '../components/Feedback.js';
import { RoundsPanel } from '../components/RoundsPanel.js';
import { StageControl } from '../components/StageControl.js';
import { Timeline } from '../components/Timeline.js';
import type { Stage } from '../domain/stages.js';

/**
 * One application — a candidate on a req — and everything a recruiter does to it:
 * read the contact details, move the stage, schedule a round, put interviewers on it,
 * and read back the trace of all of it.
 *
 * The summary comes from `GET /audit/candidates/:id` rather than from a fetch per field.
 * That endpoint already returns the candidate's name, every application they hold with
 * its req title and current stage, and the timeline — so one request answers the header,
 * the stage control's input and the trace at the bottom. It is also the request a hiring
 * manager may make, which is what lets this screen exist for them at all.
 *
 * What a hiring manager does *not* get is everything that follows: contact details and
 * round management are recruiter-only at the API, so they are not rendered rather than
 * rendered and refused. The sections that are missing are missing because the request
 * behind them is never made.
 */
export function ApplicationDetail() {
  const { candidateId = '', roleId = '' } = useParams<{ candidateId: string; roleId: string }>();
  const { user } = useSession();
  const audit = useApi(() => candidateAudit(candidateId), [candidateId]);

  const isRecruiter = user?.role === 'RECRUITER';

  if (audit.loading) return <Loading label="Loading candidate…" />;
  if (audit.error !== null) return <ErrorNotice error={audit.error} onRetry={audit.reload} />;
  if (audit.data === null) return <Loading label="Loading candidate…" />;

  const application = audit.data.applications.find((row) => row.roleId === roleId) ?? null;

  if (application === null) {
    return (
      <section className="card">
        <header className="card-head row">
          <div>
            <h2>{audit.data.candidate.name}</h2>
            <p className="muted">This candidate is not on that req.</p>
          </div>
          <Link className="go" to="/candidates">
            ← Candidates
          </Link>
        </header>
        {audit.data.applications.length > 0 && (
          <ul className="fb-list">
            {audit.data.applications.map((row) => (
              <li key={row.applicationId} className="fb">
                <Link className="go" to={`/applications/${candidateId}/${row.roleId}`}>
                  {row.roleTitle}
                </Link>{' '}
                <span className="pill">{row.currentStage}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  const currentStage = application.currentStage as Stage;

  return (
    <div className="stack">
      <section className="card">
        <header className="card-head row">
          <div>
            <h2>{audit.data.candidate.name}</h2>
            <p className="muted">
              {application.roleTitle} · applied{' '}
              {new Date(application.createdAt).toLocaleDateString()}
            </p>
          </div>
          <div className="who">
            <span className="pill">{currentStage}</span>
            <Link className="go" to="/candidates">
              ← Candidates
            </Link>
          </div>
        </header>

        {isRecruiter ? (
          <div className="pad">
            <StageControl
              candidateId={candidateId}
              roleId={roleId}
              currentStage={currentStage}
              /* The stage, the timeline and the application summary all move together. */
              onChanged={audit.reload}
            />
          </div>
        ) : (
          <p className="muted pad">
            Stage movement is a recruiter action. A hiring manager reads the pipeline and
            the trace; nothing on this screen changes what it shows.
          </p>
        )}
      </section>

      {/* The other reqs this candidate is on — the application is the pipeline unit, so a
          candidate can sit at a different stage on each. */}
      {audit.data.applications.length > 1 && (
        <section className="card">
          <header className="card-head">
            <h2>Also on</h2>
            <p className="muted">
              A candidate is not in one place in the pipeline — each application has its own
              stage, and moving one does not move the other.
            </p>
          </header>
          <table className="grid list">
            <tbody>
              {audit.data.applications
                .filter((row) => row.roleId !== roleId)
                .map((row) => (
                  <tr key={row.applicationId}>
                    <td>{row.roleTitle}</td>
                    <td>
                      <span className="pill">{row.currentStage}</span>
                    </td>
                    <td>
                      <Link className="go" to={`/applications/${candidateId}/${row.roleId}`}>
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      )}

      {isRecruiter && <ContactCard candidateId={candidateId} />}

      {isRecruiter && (
        <RoundsPanel candidateId={candidateId} roleId={roleId} currentStage={currentStage} />
      )}

      <section className="card">
        <header className="card-head">
          <h2>Timeline</h2>
          <p className="muted">
            Every entry was written inside the transaction that made the change, so this is
            a reconstruction rather than a log that might have been missed. It covers the
            candidate, not just this req.
          </p>
        </header>
        <div className="pad">
          <Timeline entries={audit.data.timeline} />
        </div>
      </section>
    </div>
  );
}
