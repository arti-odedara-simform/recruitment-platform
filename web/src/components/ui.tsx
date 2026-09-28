import type { ReactNode } from 'react';
import type { Schemas } from '../api/client.js';
import { stageLabel } from '../domain/stages.js';

/**
 * The small presentational pieces every screen repeats. None of them fetch or decide
 * anything — they exist so a stage, a person and a page title look the same wherever
 * they appear.
 */

type Role = Schemas['PublicUser']['role'];

const ROLE_LABELS: Record<Role, string> = {
  RECRUITER: 'Recruiter',
  HIRING_MANAGER: 'Hiring manager',
  INTERVIEWER: 'Interviewer',
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role as Role] ?? role;
}

export function StageBadge({ stage }: { stage: string }) {
  return <span className={`badge stage-${stage.toLowerCase()}`}>{stageLabel(stage)}</span>;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** Spread round the wheel so neighbours in a list rarely share a colour. */
const HUES = [222, 262, 192, 152, 32, 336, 8, 288, 172, 48];

/** A stable hue per name, so the same person is the same colour on every screen. */
function hue(name: string): number {
  let hash = 2166136261;
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return HUES[hash % HUES.length]!;
}

/** Whole days: "28.1 days" is precision nobody schedules by. */
export function days(value: number): string {
  const n = Math.round(value);
  return `${n} ${n === 1 ? 'day' : 'days'}`;
}

export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`avatar avatar-${size}`} style={{ '--h': hue(name) } as React.CSSProperties} aria-hidden>
      {initials(name)}
    </span>
  );
}

/** A name with its avatar; `meta` is the quieter second line. */
export function Person({ name, meta, children }: { name: string; meta?: ReactNode; children?: ReactNode }) {
  return (
    <span className="person">
      <Avatar name={name} size="sm" />
      <span className="person-text">
        <span className="person-name">{children ?? name}</span>
        {meta !== undefined && <span className="person-meta">{meta}</span>}
      </span>
    </span>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  back,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  back?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        {back}
        <h1>{title}</h1>
        {subtitle !== undefined && <p className="page-sub">{subtitle}</p>}
      </div>
      {actions !== undefined && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="empty-state">
      <p className="empty-title">{title}</p>
      {hint !== undefined && <p className="muted">{hint}</p>}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={option.value === value ? 'active' : ''}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** "in 3 days", "2 hours ago" — the phrasing a schedule is read in. */
export function relative(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ];
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === 'minute') return format.format(Math.round(diff / ms), unit);
  }
  return '';
}

/** A handful of 24px stroke icons, inline so there is nothing to load. */
const ICONS = {
  logo: 'M4 6h16M4 12h10M4 18h6',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.35-4.35',
  plus: 'M12 5v14M5 12h14',
  back: 'M15 18l-6-6 6-6',
  chevron: 'M9 18l6-6-6-6',
  alert: 'M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z',
  check: 'M20 6 9 17l-5-5',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  flag: 'M4 22V4m0 0h13l-2 4 2 4H4',
  calendar: 'M8 2v4m8-4v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z',
  user: 'M20 21a8 8 0 0 0-16 0m8-8a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  message: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z',
  briefcase: 'M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16M4 6h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9',
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

export function isPast(iso: string): boolean {
  return new Date(iso).getTime() < Date.now();
}

/** A calendar-page glyph for a scheduled time; faded once it has passed. */
export function DateTile({ iso }: { iso: string }) {
  const at = new Date(iso);
  return (
    <span className={isPast(iso) ? 'date-tile past' : 'date-tile'} aria-hidden>
      <span className="m">{at.toLocaleString(undefined, { month: 'short' })}</span>
      <span className="d">{at.getDate()}</span>
    </span>
  );
}
