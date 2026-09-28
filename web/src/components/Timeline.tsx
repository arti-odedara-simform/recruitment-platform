import type { Schemas } from '../api/client.js';
import { Icon, StageBadge, formatDateTime, roleLabel, type IconName } from './ui.js';

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
const ACTIONS: Record<string, { label: string; icon: IconName }> = {
  ROLE_OPENED: { label: 'Requisition opened', icon: 'briefcase' },
  APPLICATION_CREATED: { label: 'Added to requisition', icon: 'plus' },
  ROUND_CREATED: { label: 'Interview scheduled', icon: 'calendar' },
  ASSIGNMENT_CREATED: { label: 'Interviewer added to panel', icon: 'user' },
  FEEDBACK_SUBMITTED: { label: 'Feedback submitted', icon: 'message' },
  STAGE_ADVANCED: { label: 'Stage changed', icon: 'arrow' },
  STAGE_OVERRIDDEN: { label: 'Stage overridden', icon: 'flag' },
};

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
    return <p className="muted">No recorded activity yet.</p>;
  }

  return (
    <ol className="timeline">
      {rows.map((entry) => {
        const move = entry.type === 'STAGE_TRANSITION';
        const override = move && entry.kind === 'OVERRIDE';
        const action = move ? null : ACTIONS[entry.action];
        return (
          <li key={entry.id} className={override ? 'event move override' : move ? 'event move' : 'event'}>
            <span className="event-icon">
              <Icon name={override ? 'flag' : move ? 'arrow' : (action?.icon ?? 'check')} />
            </span>
            <div className="event-body">
              {move ? (
                <span className="what">
                  <StageBadge stage={entry.fromStage} />
                  <Icon name="arrow" />
                  <StageBadge stage={entry.toStage} />
                  {override && <span className="badge warn plain">Override</span>}
                </span>
              ) : (
                <span className="what">{action?.label ?? entry.action}</span>
              )}

              <span className="meta">
                {entry.actor.name} ({roleLabel(entry.actor.role)}) · {formatDateTime(entry.occurredAt)}
              </span>

              {move && entry.reason !== null && <p className="reason">{entry.reason}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
