import { useState } from 'react';
import { Link } from 'react-router-dom';
import { pipeline, stuck } from '../api/client.js';
import type { Schemas } from '../api/client.js';
import { useApi } from '../api/useApi.js';
import { ErrorNotice, Loading } from '../components/Feedback.js';
import { EmptyState, PageHeader, Person, StageBadge, days as dayCount } from '../components/ui.js';
import { STAGES, TERMINAL, stageLabel, type Stage } from '../domain/stages.js';

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
  return '';
}

/** A waiting time as a badge whose colour says whether it is a problem yet. */
function WaitBadge({ days }: { days: number }) {
  const tone = days >= 21 ? 'bad' : days >= 10 ? 'warn' : '';
  return (
    <span className={`badge plain ${tone}`}>
      {dayCount(days)}
    </span>
  );
}

function StageCell({ cell }: { cell: Schemas['PipelineStage'] | undefined }) {
  if (cell === undefined) {
    return <td className="empty">—</td>;
  }

  return (
    <td className={ageClass(cell.oldestAgeDays, cell.stage)}>
      <span className="count">{cell.candidates}</span>
      <span className="age" title={`Average ${dayCount(cell.averageAgeDays)} in stage, oldest ${dayCount(cell.oldestAgeDays)}`}>
        avg {Math.round(cell.averageAgeDays)}d · max {Math.round(cell.oldestAgeDays)}d
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
  const stuckRows = waiting.data ?? [];

  const totals = new Map<Stage, number>();
  for (const req of rows) {
    for (const cell of req.stages) {
      totals.set(cell.stage, (totals.get(cell.stage) ?? 0) + cell.candidates);
    }
  }
  const active = STAGES.filter((stage) => !TERMINAL.includes(stage)).reduce(
    (sum, stage) => sum + (totals.get(stage) ?? 0),
    0,
  );

  return (
    <div className="stack">
      <PageHeader
        title="Pipeline"
        subtitle="Where every open requisition stands, and who has been waiting too long."
      />

      <div className="stats">
        <div className="stat">
          <span className="stat-label">Open requisitions</span>
          <span className="stat-value">{rows.length}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Active candidates</span>
          <span className="stat-value">{active}</span>
          <span className="stat-hint">Not yet hired or rejected</span>
        </div>
        <div className="stat">
          <span className="stat-label">In offer</span>
          <span className="stat-value">{totals.get('OFFER') ?? 0}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Hired</span>
          <span className="stat-value">{totals.get('HIRED') ?? 0}</span>
        </div>
        <div className={stuckRows.length > 0 ? 'stat warn' : 'stat'}>
          <span className="stat-label">Waiting over {days} days</span>
          <span className="stat-value">{waiting.data === null ? '–' : stuckRows.length}</span>
        </div>
      </div>

      <section className="card">
        <header className="card-head">
          <div>
            <h2>By stage</h2>
            <p>Candidates per stage, with how long they have been there.</p>
          </div>
          <div className="legend" aria-hidden>
            <span>
              <i className="swatch warn" /> Oldest 10+ days
            </span>
            <span>
              <i className="swatch bad" /> Oldest 21+ days
            </span>
          </div>
        </header>

        {rows.length === 0 ? (
          <EmptyState title="No open requisitions" hint="Open a req to start building a pipeline." />
        ) : (
          <div className="scroll">
            <table className="grid funnel">
              <thead>
                <tr>
                  <th className="sticky">Requisition</th>
                  {STAGES.map((stage) => (
                    <th key={stage}>
                      <span className={`th-stage stage-${stage.toLowerCase()}`}>
                        <span className="dot" />
                        <span className="label">{stageLabel(stage)}</span>
                      </span>
                    </th>
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
        <header className="card-head">
          <div>
            <h2>Needs attention</h2>
            <p>
              Candidates who have been in the same stage for more than {days} days. Hired and
              rejected candidates are left out.
            </p>
          </div>
          <label className="actions small muted">
            Threshold
            <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
              {[7, 14, 21, 30, 60].map((option) => (
                <option key={option} value={option}>
                  {option} days
                </option>
              ))}
            </select>
          </label>
        </header>

        {waiting.error !== null ? (
          <ErrorNotice error={waiting.error} onRetry={waiting.reload} />
        ) : waiting.loading ? (
          <Loading label="Checking…" />
        ) : stuckRows.length === 0 ? (
          <EmptyState title="All caught up" hint={`Nobody has been waiting more than ${days} days.`} />
        ) : (
          <div className="scroll">
            <table className="grid list">
              <thead>
                <tr>
                  <th>Candidate</th>
                  <th>Requisition</th>
                  <th>Stage</th>
                  <th>Waiting</th>
                </tr>
              </thead>
              <tbody>
                {stuckRows.map((row) => (
                  <tr key={row.applicationId}>
                    <td>
                      {/* Straight to the screen that can do something about it. */}
                      <Person name={row.candidate.name}>
                        <Link className="row-link" to={`/applications/${row.candidate.id}/${row.roleId}`}>
                          {row.candidate.name}
                        </Link>
                      </Person>
                    </td>
                    <td className="muted">{row.roleTitle}</td>
                    <td>
                      <StageBadge stage={row.currentStage} />
                    </td>
                    <td>
                      <WaitBadge days={row.daysInStage} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
