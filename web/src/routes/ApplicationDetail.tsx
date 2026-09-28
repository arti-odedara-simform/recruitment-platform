import { Link, useParams } from 'react-router-dom';
import { candidateAudit } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { useSession } from '../auth/session.js';
import { ContactCard } from '../components/ContactCard.js';
import { ErrorNotice, Loading } from '../components/Feedback.js';
import { RoundsPanel } from '../components/RoundsPanel.js';
import { StageControl } from '../components/StageControl.js';
import { Timeline } from '../components/Timeline.js';
import { Avatar, Icon, PageHeader, StageBadge, formatDate } from '../components/ui.js';
import { STAGES, stageLabel, type Stage } from '../domain/stages.js';
import type { Schemas } from '../api/client.js';

/** The forward path; Rejected is an exit from it rather than a step on it. */
const PATH: readonly Stage[] = STAGES.filter((stage) => stage !== 'REJECTED');

/**
 * Where on the funnel this application is. A rejection is drawn as far as it got — read
 * off the transition that rejected it — so "rejected at offer" and "rejected at screen"
 * do not look the same.
 */
function Progress({
  stage,
  timeline,
  roleId,
}: {
  stage: Stage;
  timeline: Schemas['CandidateAudit']['timeline'];
  roleId: string;
}) {
  let reached: Stage = stage;
  if (stage === 'REJECTED') {
    const exit = [...timeline]
      .reverse()
      .find(
        (entry) =>
          entry.type === 'STAGE_TRANSITION' && entry.toStage === 'REJECTED' && entry.roleId === roleId,
      );
    reached = exit !== undefined && exit.type === 'STAGE_TRANSITION' ? (exit.fromStage as Stage) : 'APPLIED';
  }
  const at = PATH.indexOf(reached);
  const tone = stage === 'HIRED' ? ' hired' : stage === 'REJECTED' ? ' rejected' : '';

  return (
    <ol className={`progress${tone}`} aria-label="Stage progress">
      {PATH.map((step, index) => (
        <li
          key={step}
          className={index < at ? 'done' : index === at ? 'current done' : ''}
          aria-current={index === at ? 'step' : undefined}
        >
          {stageLabel(step)}
        </li>
      ))}
    </ol>
  );
}

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

  const back = (
    <Link className="back" to="/candidates">
      <Icon name="back" /> Candidates
    </Link>
  );

  const application = audit.data.applications.find((row) => row.roleId === roleId) ?? null;
  const others = audit.data.applications.filter((row) => row.roleId !== roleId);

  if (application === null) {
    return (
      <div className="stack">
        <PageHeader
          back={back}
          title={audit.data.candidate.name}
          subtitle="This candidate isn’t on that requisition."
        />
        {others.length > 0 && (
          <section className="card">
            <header className="card-head">
              <h2>Their requisitions</h2>
            </header>
            <ul className="side-list">
              {others.map((row) => (
                <li key={row.applicationId}>
                  <Link className="row-link" to={`/applications/${candidateId}/${row.roleId}`}>
                    {row.roleTitle}
                  </Link>
                  <StageBadge stage={row.currentStage} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    );
  }

  const currentStage = application.currentStage as Stage;
  const name = audit.data.candidate.name;

  return (
    <div className="stack">
      <div>
        {back}
        <section className="card">
          <div className="card-body stack">
            <div className="hero">
              <Avatar name={name} size="lg" />
              <div className="hero-text">
                <h1>{name}</h1>
                <div className="hero-meta">
                  <Icon name="briefcase" />
                  <span>{application.roleTitle}</span>
                  <span className="sep">•</span>
                  <span>Applied {formatDate(application.createdAt)}</span>
                </div>
              </div>
              <span style={{ marginLeft: 'auto' }}>
                <StageBadge stage={currentStage} />
              </span>
            </div>
            <Progress stage={currentStage} timeline={audit.data.timeline} roleId={roleId} />
          </div>
        </section>
      </div>

      <div className="layout-2">
        <div className="stack">
          {isRecruiter ? (
            <section className="card">
              <header className="card-head">
                <div>
                  <h2>Move stage</h2>
                  <p>Feedback never moves a candidate on its own — you decide when they advance.</p>
                </div>
              </header>
              <div className="card-body">
                <StageControl
                  candidateId={candidateId}
                  roleId={roleId}
                  currentStage={currentStage}
                  /* The stage, the timeline and the application summary all move together. */
                  onChanged={audit.reload}
                />
              </div>
            </section>
          ) : (
            <div className="notice info">
              <Icon name="user" />
              <span>Recruiters move candidates between stages. You can follow progress and history here.</span>
            </div>
          )}

          {isRecruiter && (
            <RoundsPanel candidateId={candidateId} roleId={roleId} currentStage={currentStage} />
          )}

          <section className="card">
            <header className="card-head">
              <div>
                <h2>Activity</h2>
                <p>Everything that has happened with {name.split(' ')[0]}, across all requisitions.</p>
              </div>
            </header>
            <div className="card-body">
              <Timeline entries={audit.data.timeline} />
            </div>
          </section>
        </div>

        <aside className="stack">
          {isRecruiter && <ContactCard candidateId={candidateId} />}

          {/* The other reqs this candidate is on — the application is the pipeline unit, so a
              candidate can sit at a different stage on each. */}
          {others.length > 0 && (
            <section className="card">
              <header className="card-head">
                <div>
                  <h2>Other requisitions</h2>
                  <p>Each has its own stage.</p>
                </div>
              </header>
              <ul className="side-list">
                {others.map((row) => (
                  <li key={row.applicationId}>
                    <Link className="row-link" to={`/applications/${candidateId}/${row.roleId}`}>
                      {row.roleTitle}
                    </Link>
                    <StageBadge stage={row.currentStage} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
