/**
 * What a 1..4 rating means, in one place — the list and the detail screen both render
 * ratings, and two definitions would eventually disagree.
 *
 * The API enforces the range and nothing else; the words and the colours are this UI's
 * reading of it. A four-point scale has no midpoint on purpose: it will not let a panel
 * member abstain, so every rating falls on one side of the hire line. That gives two
 * things to encode, and they are encoded separately —
 *
 *   - *which side* is the hue: 1 and 2 read as the negative token, 3 and 4 as positive.
 *   - *how strongly* is the fill: the extremes (1 and 4) are filled, the near calls
 *     (2 and 3) are outlined.
 *
 * So a 2 and a 3 do not look alike despite both being mild, and a 1 does not look like a
 * 2 despite both being a no. Neither cue is load-bearing on its own: the number is always
 * shown, and the word is on the element for anyone who can use neither.
 */
export const RATINGS = [
  { value: 1, label: 'Strong no' },
  { value: 2, label: 'No' },
  { value: 3, label: 'Yes' },
  { value: 4, label: 'Strong yes' },
] as const;

export function ratingLabel(value: number): string {
  return RATINGS.find((option) => option.value === value)?.label ?? String(value);
}

/** Compact: the number, for a table cell where several sit shoulder to shoulder. */
export function RatingMark({ value }: { value: number }) {
  const label = ratingLabel(value);
  return (
    <span className={`mark r${value}`} title={label} aria-label={label}>
      {value}
    </span>
  );
}

/** Full: the word, for a feedback entry with room to spell it out. */
export function RatingPill({ value }: { value: number }) {
  return <span className={`pill rating r${value}`}>{ratingLabel(value)}</span>;
}
