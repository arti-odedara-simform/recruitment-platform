import type { Schemas } from '../api/client.js';

/**
 * The candidate's trace, as `GET /audit/candidates/:id` returns it: two append-only
 * tables merged into one list, oldest first.
 *
 * Every row here was written **inside the transaction that made the change** — if the
 * audit write had failed, the change would have rolled back with it. So this is a
 * reconstruction of what happened, not a log that may or may not have been flushed, and
 * it is what answers a candidate who disputes how they were assessed.
 *
 * Overrides are marked, and their reason is shown rather than tucked behind a tooltip:
 * the reason is the whole point of recording an override separately from an advance.
 */

type Entry = Schemas['CandidateAudit']['timeline'][number];

/** `AuditEvent.action` is a string in the API; these are the ones it currently writes. */
const ACTIONS: Record<string, string> = {
  ROLE_OPENED: 'Req opened',
  APPLICATION_CREATED: 'Applied',
  ROUND_CREATED: 'Round scheduled',
  ASSIGNMENT_CREATED: 'Interviewer assigned',
  FEEDBACK_SUBMITTED: 'Feedback submitted',
  STAGE_ADVANCED: 'Stage advanced',
  STAGE_OVERRIDDEN: 'Stage overridden',
};

function stamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * `STAGE_ADVANCED` and `STAGE_OVERRIDDEN` arrive twice — once as the transition row and
 * once as the audit event beside it, because both tables record the same act from
 * different angles. The transition is the richer of the two, so the paired event is
 * dropped rather than rendered as a duplicate line.
 */
function isRedundant(entry: Entry): boolean {
  return (
    entry.type === 'AUDIT_EVENT' &&
    (entry.action === 'STAGE_ADVANCED' || entry.action === 'STAGE_OVERRIDDEN')
  );
}

export function Timeline({ entries }: { entries: Entry[] }) {
  const rows = entries.filter((entry) => !isRedundant(entry));

  if (rows.length === 0) {
    return <p className="muted pad">Nothing recorded yet.</p>;
  }

  return (
    <ol className="timeline">
      {rows.map((entry) => (
        <li key={entry.id} className={entry.type === 'STAGE_TRANSITION' ? 'event move' : 'event'}>
          <span className="when muted">{stamp(entry.occurredAt)}</span>

          {entry.type === 'STAGE_TRANSITION' ? (
            <span className="what">
              <span className="pill">{entry.fromStage}</span> →{' '}
              <span className="pill">{entry.toStage}</span>
              {entry.kind === 'OVERRIDE' && <span className="pill override">OVERRIDE</span>}
            </span>
          ) : (
            <span className="what">{ACTIONS[entry.action] ?? entry.action}</span>
          )}

          <span className="who muted">
            {entry.actor.name} · {entry.actor.role}
          </span>

          {entry.type === 'STAGE_TRANSITION' && entry.reason !== null && (
            <p className="reason">{entry.reason}</p>
          )}
        </li>
      ))}
    </ol>
  );
}
