import { formatPercent, LEVEL_COLORS, MEMORY_THEME, renderKey, type Level } from "./render.js";
import { formatGiB, toGiB, type MemorySnapshot, type Pressure } from "./memory.js";

// Drawing + colour rules for the Memory key, kept free of Stream Deck imports
// so scripts-check-memory.mjs can test them.

// Chosen in the key's Property Inspector (ui/memory.html).
export type MemorySettings = {
  // "free" (GB available, default), "used-pct", "used-gb" or "pressure"
  // (macOS memory pressure % with swap used underneath).
  show?: string;
  // Red below this many GB available (default 5).
  warn?: string;
  // Swap counts as high from this many GB (default 10): red swap line on the
  // pressure view, amber "SWAP" tag on the other views.
  swap?: string;
  // "on" (default) / "off": a banner when this key's own warning trips (low
  // free memory, or high swap / critical pressure on the pressure view).
  banner?: string;
};

// 5, not 7: at 7 GB, 96% of ~2,600 logged low-memory banners (11-02 → 11-06)
// fired at 6–7 GB free, i.e. normal use on this Mac; real trouble was < 3 GB.
export const DEFAULT_WARN_GIB = 5;
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

// "Swapping now": macOS writing to swap at least this fast (bytes/s, over
// the last 20s). Starting points from this Mac, which averages ~1 MB/s of
// swap writes over a month in bursts: 5 MB/s = actively swapping, 50 MB/s =
// heavy (the Mac is likely to feel slow).
export const SWAPPING_BPS = 5 * 1024 ** 2;
export const HEAVY_SWAPPING_BPS = 50 * 1024 ** 2;

export function swappingLevel(bytesPerSec: number | undefined): Level {
  if (bytesPerSec === undefined) return "ok";
  return bytesPerSec >= HEAVY_SWAPPING_BPS ? "hot" : bytesPerSec >= SWAPPING_BPS ? "mid" : "ok";
}

const LEVEL_RANK: Record<Level, number> = { ok: 0, mid: 1, hot: 2 };
export function worse(a: Level, b: Level): Level {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
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

/**
 * Amber corner tag on the free-memory views: "SWAPPING" while macOS is
 * writing to swap heavily, else "SWAP 11GB" once swap reaches the swap line.
 */
export function swapTag(snap: MemorySnapshot, line: number): string | undefined {
  if (swappingLevel(snap.swapOutBytesPerSec) === "hot") return "SWAPPING";
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
  const swapping = swappingLevel(snap.swapOutBytesPerSec);
  const swap = worse(swapLevel(snap.swapUsedBytes, swapLineGiB(settings)), swapping);
  // "↑" while macOS is writing to swap right now (5 MB/s or more).
  const arrow = swapping === "ok" ? "" : " ↑";
  return renderKey({
    big: snap.pressurePercent === undefined ? "—" : formatPercent(snap.pressurePercent),
    label: "PRESSURE",
    subtitle: snap.swapUsedBytes === undefined ? "no swap info" : `swap ${formatGiB(snap.swapUsedBytes)}${arrow}`,
    // White while swap is fine; yellow / red as it nears and passes the line,
    // or while swapping (yellow) / swapping heavily (red).
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

/** Heavy swapping counts as a swap alert, like high swap and critical pressure. */
export function heavySwapping(snap: MemorySnapshot): boolean {
  return swappingLevel(snap.swapOutBytesPerSec) === "hot";
}

/** Swap banner title: says what tripped it. */
export function swapAlertTitle(snap: MemorySnapshot, line: number): string {
  const high = snap.swapUsedBytes !== undefined && toGiB(snap.swapUsedBytes) >= line;
  if (snap.pressure === "critical") return high ? "Memory pressure critical, swap high" : "Memory pressure critical";
  if (high) return "Swap is high";
  return heavySwapping(snap) ? "Mac is swapping heavily" : "Swap is high";
}

const mbps = (bps: number) => `${Math.round(bps / 1024 ** 2)} MB/s`;

/** e.g. "Swap 11 GB (your line: 10 GB) · pressure 62% · 4.1 GB free of 36 GB. Biggest: …" */
export function swapAlertMessage(
  snap: MemorySnapshot,
  line: number,
  top: { name: string; bytes: number }[]
): string {
  const parts: string[] = [];
  if (snap.swapUsedBytes !== undefined) parts.push(`Swap ${gb(snap.swapUsedBytes)} (your line: ${line} GB)`);
  if (heavySwapping(snap)) parts.push(`writing ${mbps(snap.swapOutBytesPerSec!)} to swap`);
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
