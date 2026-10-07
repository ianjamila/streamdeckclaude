import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ageTag } from "./age.js";

// Codex CLI writes a `rate_limits` snapshot into its session log
// (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) after every turn. Reading the
// newest snapshot needs no credentials and no network. It only changes when
// Codex is used, and every use writes a fresh one, so it stays current for
// this machine (usage from other devices appears after the next local run).
// No Stream Deck imports, so it can be checked with plain node.

const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
// How many of the most recently modified session files to consider — parallel
// sessions can each hold the latest snapshot.
const RECENT_FILES = 6;
// Snapshots are written after every turn, so the tail of a file holds one.
const TAIL_BYTES = 512 * 1024;

export type CodexWindow = {
  used_percent: number;
  window_minutes: number;
  resets_at: number; // epoch seconds
};

export type CodexRateLimits = {
  primary?: CodexWindow | null;
  secondary?: CodexWindow | null;
  plan_type?: string | null;
  rate_limit_reached_type?: string | null;
};

export type CodexSnapshot = { limits: CodexRateLimits; at: number };

export type WindowKind = "weekly" | "short";

export function windowKind(w: CodexWindow): WindowKind {
  return w.window_minutes > 24 * 60 ? "weekly" : "short";
}

export function windowLabel(w: CodexWindow): string {
  const m = w.window_minutes;
  if (m % (24 * 60) === 0) return `${m / (24 * 60)}D`;
  if (m % 60 === 0) return `${m / 60}H`;
  return `${m}M`;
}

export function findWindow(limits: CodexRateLimits, kind: WindowKind): CodexWindow | undefined {
  return [limits.primary, limits.secondary].find(
    (w): w is CodexWindow => !!w && windowKind(w) === kind
  );
}

// A window whose reset time has passed is back to 0% even if Codex hasn't
// run since to write a new snapshot.
export function effectivePercent(w: CodexWindow, now: number = Date.now()): number {
  return w.resets_at * 1000 <= now ? 0 : w.used_percent;
}

async function sortedDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

// Newest-first list of session files from the newest few day folders.
async function recentSessionFiles(): Promise<string[]> {
  const root = join(CODEX_HOME, "sessions");
  const files: { file: string; mtime: number }[] = [];
  let daysScanned = 0;
  outer: for (const y of await sortedDirs(root)) {
    for (const m of await sortedDirs(join(root, y))) {
      for (const d of await sortedDirs(join(root, y, m))) {
        const dayDir = join(root, y, m, d);
        for (const name of await readdir(dayDir).catch(() => [] as string[])) {
          if (!name.endsWith(".jsonl")) continue;
          const file = join(dayDir, name);
          const s = await stat(file).catch(() => undefined);
          if (s) files.push({ file, mtime: s.mtimeMs });
        }
        if (++daysScanned >= 3 && files.length >= RECENT_FILES) break outer;
        if (daysScanned >= 14) break outer;
      }
    }
  }
  return files
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, RECENT_FILES)
    .map((f) => f.file);
}

async function readTail(file: string): Promise<string> {
  const fh = await open(file, "r");
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    // Drop a partial first line when we started mid-file.
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await fh.close();
  }
}

function findRateLimits(x: unknown): CodexRateLimits | undefined {
  if (!x || typeof x !== "object") return undefined;
  const o = x as Record<string, unknown>;
  if (o.rate_limits && typeof o.rate_limits === "object") return o.rate_limits as CodexRateLimits;
  for (const v of Object.values(o)) {
    const r = findRateLimits(v);
    if (r) return r;
  }
  return undefined;
}

// When each turn in the file started (Codex writes "task_started" as it
// begins replying to a message).
function turnStartsIn(lines: string[]): number[] {
  const starts: number[] = [];
  for (const line of lines) {
    if (!line.includes('"task_started"')) continue;
    try {
      const o = JSON.parse(line) as { timestamp?: string; payload?: { type?: string } };
      const at = o.timestamp ? Date.parse(o.timestamp) : NaN;
      if (o.payload?.type === "task_started" && Number.isFinite(at)) starts.push(at);
    } catch {
      continue;
    }
  }
  return starts;
}

async function scanFile(file: string): Promise<{ snap?: CodexSnapshot; turnStarts: number[] }> {
  const lines = (await readTail(file)).split("\n");
  return { snap: latestIn(lines), turnStarts: turnStartsIn(lines) };
}

function latestIn(lines: string[]): CodexSnapshot | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"rate_limits"')) continue;
    try {
      const o = JSON.parse(line) as { timestamp?: string };
      const limits = findRateLimits(o);
      if (!limits || (!limits.primary && !limits.secondary)) continue;
      const at = o.timestamp ? Date.parse(o.timestamp) : NaN;
      return { limits, at: Number.isFinite(at) ? at : 0 };
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function readCodexSnapshot(): Promise<CodexSnapshot | undefined> {
  return newestSnapshot(await recentSessionFiles());
}

async function scanFiles(files: string[]): Promise<{ snap?: CodexSnapshot; turnStarts: number[] }> {
  let best: CodexSnapshot | undefined;
  const turnStarts: number[] = [];
  for (const file of files) {
    const scan = await scanFile(file).catch(() => undefined);
    if (!scan) continue;
    turnStarts.push(...scan.turnStarts);
    if (scan.snap && (!best || scan.snap.at > best.at)) best = scan.snap;
  }
  return { snap: best, turnStarts };
}

async function newestSnapshot(files: string[]): Promise<CodexSnapshot | undefined> {
  return (await scanFiles(files)).snap;
}

// Every Codex reply logs a usage snapshot within seconds (median 13s, worst
// 106s over 94 turns measured 2026-10-07). So turns that started well before
// now, after the newest snapshot, and never logged one mean Codex is being
// used but its replies aren't coming back: signed out, offline, or a log
// format change. Two such turns, not one: quitting Codex mid-reply leaves a
// single silent turn behind (seen twice in the same sample).
export const STALL_AFTER_MS = 10 * 60_000;
export const STALL_TURNS = 2;

export function stalledTurns(snapAt: number, turnStarts: number[], now = Date.now()): boolean {
  const silent = turnStarts.filter((t) => t > snapAt && now - t > STALL_AFTER_MS);
  return silent.length >= STALL_TURNS;
}

// Like readCodexSnapshot, but says why there is no snapshot, as the short
// hint drawn under the "!" (same style as errorHint in usage.ts):
// NO SESSIONS = no Codex session logs in the last 14 days (or no ~/.codex),
// NO DATA = sessions exist but none recorded rate limits yet.
// Codex logs rate limits only when it replies, so after a quiet day the
// newest snapshot can be old. Returns a tag like "2D OLD" once it is at least
// a day old, or undefined (fresh, or no timestamp to judge by).
export const STALE_AFTER_MS = 24 * 60 * 60_000;

export function staleTag(snapAt: number, now = Date.now()): string | undefined {
  if (!snapAt) return undefined;
  const age = now - snapAt;
  return age < STALE_AFTER_MS ? undefined : ageTag(age);
}

// `attention`: the user should look (Codex replies stopped reporting usage),
// as opposed to there simply being nothing to show yet.
export type CodexStatus =
  | { ok: true; snap: CodexSnapshot }
  | { ok: false; hint: string; attention?: boolean };

export async function readCodexStatus(): Promise<CodexStatus> {
  const files = await recentSessionFiles();
  if (files.length === 0) return { ok: false, hint: "NO SESSIONS" };
  const { snap, turnStarts } = await scanFiles(files);
  if (stalledTurns(snap?.at ?? 0, turnStarts)) return { ok: false, hint: "CHECK CODEX", attention: true };
  return snap ? { ok: true, snap } : { ok: false, hint: "NO DATA" };
}
