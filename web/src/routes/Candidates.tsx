import { useState } from 'react';
import { Link } from 'react-router-dom';
import { applications, roles } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { ErrorNotice, Loading } from '../components/Feedback.js';
import { STAGES, TERMINAL, type Stage } from '../domain/stages.js';

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

const STATUSES: StatusFilter[] = ['OPEN', 'CLOSED', 'ALL'];

/** Same thresholds the pipeline view colours by, and the same reason terminal is exempt. */
function ageClass(days: number, stage: Stage): string {
  if (TERMINAL.includes(stage)) return '';
  if (days >= 21) return 'age-bad';
  if (days >= 10) return 'age-warn';
  return '';
}

export function Candidates() {
  const [roleId, setRoleId] = useState('');
  const [stage, setStage] = useState<Stage | ''>('');
  const [roleStatus, setRoleStatus] = useState<StatusFilter>('OPEN');

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

  return (
    <section className="card">
      <header className="card-head row">
        <div>
          <h2>Candidates</h2>
          <p className="muted">
            One row per application — the pipeline unit is a candidate <em>on a req</em>,
            so someone on two reqs appears twice, at two stages. Longest-waiting first.
          </p>
        </div>
        <div className="tabs">
          {STATUSES.map((filter) => (
            <button
              key={filter}
              type="button"
              className={filter === roleStatus ? 'tab active' : 'tab'}
              onClick={() => setRoleStatus(filter)}
              title={filter === 'OPEN' ? 'Open reqs only — a closed req is history' : undefined}
            >
              {filter}
            </button>
          ))}
        </div>
      </header>

      <div className="filters pad">
        <label className="inline">
          Req
          <select value={roleId} onChange={(event) => setRoleId(event.target.value)}>
            <option value="">Every req</option>
            {(reqs.data ?? []).map((req) => (
              <option key={req.id} value={req.id}>
                {req.title}
              </option>
            ))}
          </select>
        </label>
        <label className="inline">
          Stage
          <select value={stage} onChange={(event) => setStage(event.target.value as Stage | '')}>
            <option value="">Every stage</option>
            {STAGES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      </div>

      {rows.loading ? (
        <Loading label="Loading candidates…" />
      ) : rows.error !== null ? (
        <ErrorNotice error={rows.error} onRetry={rows.reload} />
      ) : (rows.data ?? []).length === 0 ? (
        <p className="muted pad">Nobody matches that filter.</p>
      ) : (
        <table className="grid list">
          <thead>
            <tr>
              <th>Candidate</th>
              <th>Req</th>
              <th>Stage</th>
              <th>Waiting</th>
              <th>Rounds</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(rows.data ?? []).map((row) => (
              <tr key={row.applicationId}>
                <td>{row.candidate.name}</td>
                <td className="muted">
                  {row.roleTitle}
                  {row.roleStatus === 'CLOSED' && <span className="pill closed"> CLOSED</span>}
                </td>
                <td>
                  <span className="pill">{row.currentStage}</span>
                </td>
                <td className={ageClass(row.daysInStage, row.currentStage as Stage)}>
                  {row.daysInStage}d
                </td>
                <td className="muted">{row.roundCount === 0 ? '—' : row.roundCount}</td>
                <td>
                  <Link className="go" to={`/applications/${row.candidate.id}/${row.roleId}`}>
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
