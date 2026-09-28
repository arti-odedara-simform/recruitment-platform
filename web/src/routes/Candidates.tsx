import { useState } from 'react';
import { Link } from 'react-router-dom';
import { applications, roles } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { useSession } from '../auth/session.js';
import { AddToReqForm } from '../components/AddToReqForm.js';
import { ErrorNotice, Loading } from '../components/Feedback.js';
import { EmptyState, Icon, PageHeader, Person, Segmented, StageBadge, days } from '../components/ui.js';
import { STAGES, TERMINAL, stageLabel, type Stage } from '../domain/stages.js';

/**
 * The work queue: who is on which req, and where they are.
 *
 * `GET /pipeline` answers *how many* and `GET /pipeline/stuck` answers *which ones are
 * late*; this answers *who*, and it is the screen every recruiter action is reached from.
 *
 * The rows carry a candidate's id and name and nothing else. Contact details are one
 * record at a time from the detail screen, which is not a UI decision — no list endpoint
 * in this API selects those columns, so there is nothing here to have hidden.
 */

type StatusFilter = 'OPEN' | 'CLOSED' | 'ALL';

const STATUSES = [
  { value: 'OPEN', label: 'Open reqs' },
  { value: 'CLOSED', label: 'Closed reqs' },
  { value: 'ALL', label: 'All' },
] as const satisfies ReadonlyArray<{ value: StatusFilter; label: string }>;

/** Same thresholds the pipeline view colours by, and the same reason terminal is exempt. */
function ageTone(days: number, stage: Stage): string {
  if (TERMINAL.includes(stage)) return '';
  if (days >= 21) return 'bad';
  if (days >= 10) return 'warn';
  return '';
}

export function Candidates() {
  const { user } = useSession();
  const [roleId, setRoleId] = useState('');
  const [stage, setStage] = useState<Stage | ''>('');
  const [roleStatus, setRoleStatus] = useState<StatusFilter>('OPEN');
  const [adding, setAdding] = useState(false);

  const reqs = useApi(() => roles('ALL'), []);
  const rows = useApi(
    () =>
      applications({
        ...(roleId === '' ? {} : { roleId }),
        ...(stage === '' ? {} : { stage }),
        roleStatus,
      }),
    [roleId, stage, roleStatus],
  );

  const isRecruiter = user?.role === 'RECRUITER';
  const list = rows.data ?? [];
  const filtered = roleId !== '' || stage !== '';

  return (
    <div className="stack">
      <PageHeader
        title="Candidates"
        subtitle="Everyone in the pipeline, longest-waiting first. Someone on two requisitions appears once for each."
        actions={
          /*
            Recruiters only, the same courtesy the navigation extends: `POST /applications`
            is theirs, and a hiring manager pressing this could only collect a 403.
          */
          isRecruiter && !adding ? (
            <button type="button" onClick={() => setAdding(true)}>
              <Icon name="plus" /> Add to req
            </button>
          ) : undefined
        }
      />

      {adding && <AddToReqForm onAdded={rows.reload} onClose={() => setAdding(false)} />}

      <section className="card">
        <div className="toolbar">
          <select
            aria-label="Requisition"
            value={roleId}
            onChange={(event) => setRoleId(event.target.value)}
          >
            <option value="">All requisitions</option>
            {(reqs.data ?? []).map((req) => (
              <option key={req.id} value={req.id}>
                {req.title}
              </option>
            ))}
          </select>
          <select
            aria-label="Stage"
            value={stage}
            onChange={(event) => setStage(event.target.value as Stage | '')}
          >
            <option value="">All stages</option>
            {STAGES.map((option) => (
              <option key={option} value={option}>
                {stageLabel(option)}
              </option>
            ))}
          </select>
          {filtered && (
            <button
              type="button"
              className="ghost sm"
              onClick={() => {
                setRoleId('');
                setStage('');
              }}
            >
              Clear filters
            </button>
          )}
          <span style={{ marginLeft: 'auto' }}>
            <Segmented label="Requisition status" value={roleStatus} options={STATUSES} onChange={setRoleStatus} />
          </span>
        </div>

        {rows.loading ? (
          <Loading label="Loading candidates…" />
        ) : rows.error !== null ? (
          <ErrorNotice error={rows.error} onRetry={rows.reload} />
        ) : list.length === 0 ? (
          <EmptyState
            title={filtered ? 'Nobody matches these filters' : 'No candidates yet'}
            hint={filtered ? 'Try a different requisition or stage.' : undefined}
          />
        ) : (
          <div className="scroll">
            <table className="grid list">
              <thead>
                <tr>
                  <th>Candidate</th>
                  <th>Requisition</th>
                  <th>Stage</th>
                  <th>In stage</th>
                  <th className="right">Rounds</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((row) => {
                  const href = `/applications/${row.candidate.id}/${row.roleId}`;
                  const tone = ageTone(row.daysInStage, row.currentStage as Stage);
                  return (
                    <tr key={row.applicationId}>
                      <td>
                        <Person name={row.candidate.name}>
                          <Link className="row-link" to={href}>
                            {row.candidate.name}
                          </Link>
                        </Person>
                      </td>
                      <td>
                        <span className="actions">
                          <span className="muted">{row.roleTitle}</span>
                          {row.roleStatus === 'CLOSED' && <span className="badge closed plain">Closed</span>}
                        </span>
                      </td>
                      <td>
                        <StageBadge stage={row.currentStage} />
                      </td>
                      <td>
                        <span className={`badge plain ${tone}`}>
                          {days(row.daysInStage)}
                        </span>
                      </td>
                      <td className="right num muted">{row.roundCount === 0 ? '—' : row.roundCount}</td>
                      <td className="right">
                        <Link className="row-link muted" to={href} aria-label={`Open ${row.candidate.name}`}>
                          <Icon name="chevron" />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
