import { formatPercent, LEVEL_COLORS, MEMORY_THEME, renderKey, type Level } from "./render.js";
import { formatGiB, toGiB, type MemorySnapshot, type Pressure } from "./memory.js";

// Drawing + colour rules for the Memory key, kept free of Stream Deck imports
// so scripts-check-memory.mjs can test them.

// Chosen in the key's Property Inspector (ui/memory.html).
export type MemorySettings = {
  // "free" (GB available, default), "used-pct", "used-gb" or "pressure"
  // (macOS memory pressure % with swap used underneath).
  show?: string;
  // Red below this many GB available (default 7).
  warn?: string;
  // Swap counts as high from this many GB (default 10): red swap line on the
  // pressure view, amber "SWAP" tag on the other views.
  swap?: string;
  // "on" (default) / "off": a banner when this key's own warning trips (low
  // free memory, or high swap / critical pressure on the pressure view).
  banner?: string;
};

export const DEFAULT_WARN_GIB = 7;
// Yellow from warn up to warn + MID_MARGIN_GIB available.
export const MID_MARGIN_GIB = 3;
export const DEFAULT_SWAP_GIB = 10;
// Swap shows yellow from SWAP_MID_MARGIN_GIB below the swap line.
export const SWAP_MID_MARGIN_GIB = 3;

function positive(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function warnGiB(settings: MemorySettings): number {
  return positive(settings.warn, DEFAULT_WARN_GIB);
}

export function swapLineGiB(settings: MemorySettings): number {
  return positive(settings.swap, DEFAULT_SWAP_GIB);
}

export function isPressureView(settings: MemorySettings): boolean {
  return settings.show === "pressure";
}

/**
 * Free-memory views: red below `warn` GB available, yellow below warn + 3,
 * else green. Only the GB figure counts; macOS pressure has its own view.
 */
export function memoryLevel(snap: MemorySnapshot, warn: number): Level {
  const avail = toGiB(snap.availableBytes);
  return avail < warn ? "hot" : avail < warn + MID_MARGIN_GIB ? "mid" : "ok";
}

/** Pressure view number: macOS's own rating, as Activity Monitor colours its graph. */
export function pressureLevel(pressure: Pressure | undefined): Level {
  if (pressure === "critical") return "hot";
  if (pressure === "warn") return "mid";
  return "ok";
}

/** Red at or above the swap line, yellow within 3 GB below it, else green. */
export function swapLevel(swapBytes: number | undefined, line: number): Level {
  if (swapBytes === undefined) return "ok";
  const g = toGiB(swapBytes);
  return g >= line ? "hot" : g >= line - SWAP_MID_MARGIN_GIB ? "mid" : "ok";
}

/** Amber corner tag on the free-memory views once swap reaches the swap line. */
export function swapTag(snap: MemorySnapshot, line: number): string | undefined {
  if (swapLevel(snap.swapUsedBytes, line) !== "hot") return undefined;
  return `SWAP ${formatGiB(snap.swapUsedBytes!)}`;
}

export function renderMemoryKey(snap: MemorySnapshot, settings: MemorySettings): string {
  if (isPressureView(settings)) return renderPressureKey(snap, settings);
  const level = memoryLevel(snap, warnGiB(settings));
  const tag = swapTag(snap, swapLineGiB(settings));
  if (settings.show === "used-pct") {
    return renderKey({
      big: formatPercent((snap.usedBytes / snap.totalBytes) * 100),
      label: "RAM USED",
      subtitle: `${formatGiB(snap.availableBytes)} free`,
      level,
      spark: snap.usedHistory,
      tag,
      theme: MEMORY_THEME,
    });
  }
  if (settings.show === "used-gb") {
    return renderKey({
      big: formatGiB(snap.usedBytes),
      label: "RAM USED",
      subtitle: `of ${formatGiB(snap.totalBytes)}`,
      level,
      spark: snap.usedHistory,
      tag,
      theme: MEMORY_THEME,
    });
  }
  // Free view: graph the free share so the line falls when the number falls.
  // Each used point is the peak of its 10s, so this is the low point of free.
  return renderKey({
    big: formatGiB(snap.availableBytes),
    label: "RAM FREE",
    subtitle: `of ${formatGiB(snap.totalBytes)}`,
    level,
    spark: snap.usedHistory.map((u) => 1 - u),
    tag,
    theme: MEMORY_THEME,
  });
}

function renderPressureKey(snap: MemorySnapshot, settings: MemorySettings): string {
  const swap = swapLevel(snap.swapUsedBytes, swapLineGiB(settings));
  return renderKey({
    big: snap.pressurePercent === undefined ? "—" : formatPercent(snap.pressurePercent),
    label: "PRESSURE",
    subtitle: snap.swapUsedBytes === undefined ? "no swap info" : `swap ${formatGiB(snap.swapUsedBytes)}`,
    // White while swap is fine; yellow / red as it nears and passes the line.
    subtitleColor: swap === "ok" ? undefined : LEVEL_COLORS[swap],
    level: pressureLevel(snap.pressure),
    spark: snap.pressureHistory,
    theme: MEMORY_THEME,
  });
}

const gb = (b: number) => formatGiB(b).replace("GB", " GB");

/** Banner text, e.g. "6.8 GB free of 36 GB (your line: 7 GB) · swap 4.6 GB". */
export function lowMemoryMessage(
  snap: MemorySnapshot,
  warn: number,
  top: { name: string; bytes: number }[]
): string {
  let msg = `${gb(snap.availableBytes)} free of ${gb(snap.totalBytes)} (your line: ${warn} GB)`;
  if (snap.swapUsedBytes) msg += ` · swap ${gb(snap.swapUsedBytes)}`;
  return withTop(msg, top);
}

/** Swap banner title: says which of the two tripped it. */
export function swapAlertTitle(snap: MemorySnapshot, line: number): string {
  const high = snap.swapUsedBytes !== undefined && toGiB(snap.swapUsedBytes) >= line;
  if (snap.pressure === "critical") return high ? "Memory pressure critical, swap high" : "Memory pressure critical";
  return "Swap is high";
}

/** e.g. "Swap 11 GB (your line: 10 GB) · pressure 62% · 4.1 GB free of 36 GB. Biggest: …" */
export function swapAlertMessage(
  snap: MemorySnapshot,
  line: number,
  top: { name: string; bytes: number }[]
): string {
  const parts: string[] = [];
  if (snap.swapUsedBytes !== undefined) parts.push(`Swap ${gb(snap.swapUsedBytes)} (your line: ${line} GB)`);
  if (snap.pressurePercent !== undefined) {
    parts.push(`pressure ${formatPercent(snap.pressurePercent)}${snap.pressure === "critical" ? " (critical)" : ""}`);
  }
  parts.push(`${gb(snap.availableBytes)} free of ${gb(snap.totalBytes)}`);
  return withTop(parts.join(" · "), top);
}

function withTop(msg: string, top: { name: string; bytes: number }[]): string {
  if (top.length) msg += `. Biggest: ${top.map((t) => `${t.name} ${gb(t.bytes)}`).join(", ")}`;
  return msg + ".";
}
