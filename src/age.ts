// Short "how old" tag for figures that may be out of date, e.g. "20M OLD",
// "3H OLD", "2D OLD", "7D+ OLD". Rounds down; callers decide the threshold.
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function ageTag(ageMs: number): string {
  if (ageMs < HOUR) return `${Math.max(1, Math.floor(ageMs / MIN))}M OLD`;
  if (ageMs < DAY) return `${Math.floor(ageMs / HOUR)}H OLD`;
  const days = Math.floor(ageMs / DAY);
  return days >= 7 ? "7D+ OLD" : `${days}D OLD`;
}
