// Claude peak hours, ported from https://claude-peak-time.pages.dev/
// Canonical window: Mon–Fri 05:00–11:00 America/Los_Angeles, so the UTC
// window shifts with US daylight saving (13–19 UTC in PST, 12–18 UTC in PDT).
// Pure module (no Stream Deck imports) so it can be checked with plain node.

const PT_ZONE = "America/Los_Angeles";
const PT_PEAK_START = 5;
const PT_PEAK_END = 11;
const HOUR_MS = 3_600_000;
// Longest gap between transitions is Fri 11:00 → Mon 05:00 PT (66h);
// 8 days of hourly steps is a generous upper bound.
const MAX_SCAN_HOURS = 8 * 24;

const ptParts = new Intl.DateTimeFormat("en-US", {
  timeZone: PT_ZONE,
  weekday: "short",
  hour: "numeric",
  hourCycle: "h23",
});

export function isPeakAt(ms: number): boolean {
  let weekday = "";
  let hour = -1;
  for (const p of ptParts.formatToParts(new Date(ms))) {
    if (p.type === "weekday") weekday = p.value;
    else if (p.type === "hour") hour = parseInt(p.value, 10);
  }
  const isWeekday = weekday !== "Sat" && weekday !== "Sun";
  return isWeekday && hour >= PT_PEAK_START && hour < PT_PEAK_END;
}

export type PeakState = {
  peak: boolean;
  // When the current state flips (peak ends, or next peak starts).
  changesAt: number;
};

export function peakState(now: number = Date.now()): PeakState {
  const peak = isPeakAt(now);
  // Pacific offsets are whole hours and DST switches at 02:00 PT, so every
  // transition lands on a UTC top-of-hour. Walk hour boundaries until it flips.
  let t = Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS;
  for (let i = 0; i < MAX_SCAN_HOURS; i++, t += HOUR_MS) {
    if (isPeakAt(t) !== peak) return { peak, changesAt: t };
  }
  return { peak, changesAt: t };
}

