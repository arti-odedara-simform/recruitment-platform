import { useState } from 'react';
import { Link } from 'react-router-dom';
import { pipeline, stuck } from '../api/client.js';
import type { Schemas } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { ErrorNotice, Loading } from '../components/Feedback.js';
import { STAGES, TERMINAL, type Stage } from '../domain/stages.js';

/**
 * The §6 view: counts per stage per open req, with ageing.
 *
 * Stage order is the enum's declaration order, not the alphabet — the API returns cells
 * in that order and this table repeats it, so a funnel reads left to right. Both the
 * order and the terminal pair come from `domain/stages.ts`, so this screen and the
 * recruiter screens cannot disagree about either.
 */

/** Anything sitting this long in one stage is worth a second look; the API's own default. */
const STUCK_DAYS = 14;

/**
 * Ageing means nothing in a terminal stage, and colouring it as though it did was a bug
 * the first screenshot caught: a candidate hired 48 days ago was rendered in the same
 * alarming red as one stalled in INTERVIEW for 24. It is the same argument
 * `GET /pipeline/stuck` makes by excluding these two stages outright — they are done,
 * not stuck — so the count still shows and the clock is left uncoloured.
 */
function ageClass(days: number | undefined, stage?: Stage): string {
  if (days === undefined || (stage !== undefined && TERMINAL.includes(stage))) return '';
  if (days >= 21) return 'age-bad';
  if (days >= 10) return 'age-warn';
  return 'age-ok';
}

function StageCell({ cell }: { cell: Schemas['PipelineStage'] | undefined }) {
  if (cell === undefined) {
    return <td className="empty">—</td>;
  }

  return (
    <td className={ageClass(cell.oldestAgeDays, cell.stage)}>
      <span className="count">{cell.candidates}</span>
      <span className="age" title={`average ${cell.averageAgeDays}d, oldest ${cell.oldestAgeDays}d`}>
        {cell.averageAgeDays}d avg · {cell.oldestAgeDays}d max
      </span>
    </td>
  );
}

export function Pipeline() {
  const [days, setDays] = useState(STUCK_DAYS);

  const reqs = useApi(() => pipeline(), []);
  const waiting = useApi(() => stuck(days), [days]);

  if (reqs.loading) return <Loading label="Loading pipeline…" />;
  if (reqs.error !== null) return <ErrorNotice error={reqs.error} onRetry={reqs.reload} />;

  const rows = reqs.data ?? [];

  return (
    <div className="stack">
      <section className="card">
        <header className="card-head">
          <h2>Pipeline</h2>
          <p className="muted">
            Counts and time-in-stage per open req. One grouped aggregate — no candidate row
            leaves the database to produce this.
          </p>
        </header>

        {rows.length === 0 ? (
          <p className="muted pad">No open reqs.</p>
        ) : (
          <div className="scroll">
            <table className="grid">
              <thead>
                <tr>
                  <th className="sticky">Req</th>
                  {STAGES.map((stage) => (
                    <th key={stage}>{stage}</th>
                  ))}
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((req) => {
                  const byStage = new Map(req.stages.map((cell) => [cell.stage, cell]));
                  return (
                    <tr key={req.roleId}>
                      <th className="sticky" scope="row">
                        {req.title}
                      </th>
                      {STAGES.map((stage) => (
                        <StageCell key={stage} cell={byStage.get(stage)} />
                      ))}
                      <td className="total">{req.totalCandidates}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <header className="card-head row">
          <div>
            <h2>Waiting too long</h2>
            <p className="muted">
              Applications in the same stage for more than {days} days. Hired and rejected
              are excluded — they are done, not stuck.
            </p>
          </div>
          <label className="inline">
            Days
            <input
              type="number"
              min={1}
              max={365}
              value={days}
              onChange={(event) => setDays(Math.max(1, Number(event.target.value) || 1))}
            />
          </label>
        </header>

        {waiting.error !== null ? (
          <ErrorNotice error={waiting.error} onRetry={waiting.reload} />
        ) : waiting.loading ? (
          <Loading label="Checking…" />
        ) : (waiting.data ?? []).length === 0 ? (
          <p className="muted pad">Nothing has been waiting that long.</p>
        ) : (
          <table className="grid list">
            <thead>
              <tr>
                <th>Candidate</th>
                <th>Req</th>
                <th>Stage</th>
                <th>Waiting</th>
              </tr>
            </thead>
            <tbody>
              {(waiting.data ?? []).map((row) => (
                <tr key={row.applicationId}>
                  <td>
                    {/* Straight to the screen that can do something about it. */}
                    <Link className="go" to={`/applications/${row.candidate.id}/${row.roleId}`}>
                      {row.candidate.name}
                    </Link>
                  </td>
                  <td className="muted">{row.roleTitle}</td>
                  <td>
                    <span className="pill">{row.currentStage}</span>
                  </td>
                  <td className={ageClass(row.daysInStage)}>{row.daysInStage}d</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
