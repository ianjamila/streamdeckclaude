import { formatPercent, MEMORY_THEME, renderKey, type Level } from "./render.js";
import { formatGiB, toGiB, type MemorySnapshot } from "./memory.js";

// Drawing + colour rules for the Memory key, kept free of Stream Deck imports
// so scripts-check-memory.mjs can test them.

// Chosen in the key's Property Inspector (ui/memory.html).
export type MemorySettings = {
  // "free" (GB available, default), "used-pct" or "used-gb".
  show?: string;
  // Red below this many GB available (default 7).
  warn?: string;
  // "on" (default) / "off": a banner the first time free memory drops below `warn`.
  banner?: string;
};

export const DEFAULT_WARN_GIB = 7;
// Yellow from warn up to warn + MID_MARGIN_GIB available.
export const MID_MARGIN_GIB = 3;

export function warnGiB(settings: MemorySettings): number {
  const n = Number(settings.warn);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WARN_GIB;
}

/**
 * Red below `warn` GB available, yellow below warn + 3, else green. macOS
 * memory pressure can only make it worse: "warn" is at least yellow,
 * "critical" is red whatever the GB figure says.
 */
export function memoryLevel(snap: MemorySnapshot, warn: number): Level {
  const avail = toGiB(snap.availableBytes);
  let level: Level = avail < warn ? "hot" : avail < warn + MID_MARGIN_GIB ? "mid" : "ok";
  if (snap.pressure === "critical") level = "hot";
  else if (snap.pressure === "warn" && level === "ok") level = "mid";
  return level;
}

export function renderMemoryKey(snap: MemorySnapshot, settings: MemorySettings): string {
  const level = memoryLevel(snap, warnGiB(settings));
  const spark = snap.usedHistory;
  if (settings.show === "used-pct") {
    return renderKey({
      big: formatPercent((snap.usedBytes / snap.totalBytes) * 100),
      label: "RAM USED",
      subtitle: `${formatGiB(snap.availableBytes)} free`,
      level,
      spark,
      theme: MEMORY_THEME,
    });
  }
  if (settings.show === "used-gb") {
    return renderKey({
      big: formatGiB(snap.usedBytes),
      label: "RAM USED",
      subtitle: `of ${formatGiB(snap.totalBytes)}`,
      level,
      spark,
      theme: MEMORY_THEME,
    });
  }
  return renderKey({
    big: formatGiB(snap.availableBytes),
    label: "RAM FREE",
    subtitle: `of ${formatGiB(snap.totalBytes)}`,
    level,
    spark,
    theme: MEMORY_THEME,
  });
}

/** Banner text, e.g. "6.8 GB free of 36 GB (your line: 7 GB) · swap 4.6 GB". */
export function lowMemoryMessage(
  snap: MemorySnapshot,
  warn: number,
  top: { name: string; bytes: number }[]
): string {
  const gb = (b: number) => `${formatGiB(b).slice(0, -1)} GB`;
  let msg = `${gb(snap.availableBytes)} free of ${gb(snap.totalBytes)} (your line: ${warn} GB)`;
  if (snap.swapUsedBytes) msg += ` · swap ${gb(snap.swapUsedBytes)}`;
  if (top.length) msg += `. Biggest: ${top.map((t) => `${t.name} ${gb(t.bytes)}`).join(", ")}`;
  return msg + ".";
}
