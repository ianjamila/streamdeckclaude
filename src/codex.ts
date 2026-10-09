import { open, readdir, readFile, stat } from "node:fs/promises";
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

// A turn that ended in an error Codex explained: the usage limit is used up
// ("limit", with the reset time when the message gives one) or Codex isn't
// signed in ("auth"). Such turns log no usage snapshot, but they aren't silent.
export type TurnError =
  | { kind: "limit"; at: number; until?: number }
  | { kind: "auth"; at: number };

// Codex writes "task_started" as it begins replying to a message and
// "task_complete" (with `error` when the reply failed) when it is done.
type TurnScan = { starts: { at: number; id?: string }[]; errors: (TurnError & { id?: string })[] };

const AUTH_ERROR = /\b401\b|unauthori[sz]ed|not logged in|log ?in again|sign in again/i;

export function classifyTurnError(
  error: { codex_error_info?: unknown; message?: unknown },
  at: number
): TurnError | undefined {
  const info = typeof error.codex_error_info === "string" ? error.codex_error_info : "";
  const message = typeof error.message === "string" ? error.message : "";
  if (info === "usage_limit_exceeded") return { kind: "limit", at, until: limitResetFrom(message, at) };
  if (/auth/i.test(info) || AUTH_ERROR.test(message)) return { kind: "auth", at };
  return undefined;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// "…try again at Oct 14th, 2026 11:29 AM." (local time), or "…try again at
// 11:29 AM." when the reset is within a day of the error. Epoch ms, or
// undefined when the message has neither.
export function limitResetFrom(message: string, errorAt: number): number | undefined {
  const time = /(\d{1,2}):(\d{2})\s*([AP]M)/i.exec(message.slice(message.search(/try again at/i)));
  if (!/try again at/i.test(message) || !time) return undefined;
  const hour = (Number(time[1]) % 12) + (time[3].toUpperCase() === "PM" ? 12 : 0);
  const minute = Number(time[2]);
  const date = /try again at ([A-Za-z]{3})[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})/i.exec(message);
  if (date) {
    const month = MONTHS.indexOf(date[1].toLowerCase());
    if (month < 0) return undefined;
    return new Date(Number(date[3]), month, Number(date[2]), hour, minute).getTime();
  }
  const sameDay = new Date(errorAt);
  sameDay.setHours(hour, minute, 0, 0);
  const t = sameDay.getTime();
  return t > errorAt ? t : t + 24 * 60 * 60_000;
}

function turnsIn(lines: string[]): TurnScan {
  const scan: TurnScan = { starts: [], errors: [] };
  for (const line of lines) {
    const started = line.includes('"task_started"');
    if (!started && !(line.includes('"task_complete"') && line.includes('"error"'))) continue;
    try {
      const o = JSON.parse(line) as {
        timestamp?: string;
        payload?: { type?: string; turn_id?: string; error?: { codex_error_info?: unknown; message?: unknown } | null };
      };
      const at = o.timestamp ? Date.parse(o.timestamp) : NaN;
      if (!Number.isFinite(at)) continue;
      const id = o.payload?.turn_id;
      if (o.payload?.type === "task_started") scan.starts.push({ at, id });
      else if (o.payload?.type === "task_complete" && o.payload.error) {
        const error = classifyTurnError(o.payload.error, at);
        if (error) scan.errors.push({ ...error, id });
      }
    } catch {
      continue;
    }
  }
  return scan;
}

async function scanFile(file: string): Promise<{ snap?: CodexSnapshot } & TurnScan> {
  const lines = (await readTail(file)).split("\n");
  return { snap: latestIn(lines), ...turnsIn(lines) };
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

async function scanFiles(files: string[]): Promise<{ snap?: CodexSnapshot; turnStarts: number[]; errors: TurnError[] }> {
  let best: CodexSnapshot | undefined;
  const turnStarts: number[] = [];
  const errors: TurnError[] = [];
  for (const file of files) {
    const scan = await scanFile(file).catch(() => undefined);
    if (!scan) continue;
    // A turn that ended in an explained error isn't a silent one.
    const explained = new Set(scan.errors.map((e) => e.id).filter(Boolean));
    turnStarts.push(...scan.starts.filter((s) => !s.id || !explained.has(s.id)).map((s) => s.at));
    errors.push(...scan.errors.map(({ id: _id, ...e }) => e));
    if (scan.snap && (!best || scan.snap.at > best.at)) best = scan.snap;
  }
  return { snap: best, turnStarts, errors };
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

// Codex keeps its login in CODEX_HOME/auth.json unless config.toml moves it
// to the system keyring. Returns when that file last changed, 0 when it is
// missing (signed out), or undefined when the login may be in the keyring
// (can't tell from here).
async function loginFileTime(): Promise<number | undefined> {
  const config = await readFile(join(CODEX_HOME, "config.toml"), "utf8").catch(() => "");
  if (/^\s*cli_auth_credentials_store\s*=\s*["'](keyring|auto)["']/m.test(config)) return undefined;
  const s = await stat(join(CODEX_HOME, "auth.json")).catch(() => undefined);
  return s ? s.mtimeMs : 0;
}

// When the limit message gives no reset time: the snapshot's used-up window
// says when it resets; failing that, assume a week (the longest window).
export function limitUntil(limit: Extract<TurnError, { kind: "limit" }>, snap?: CodexSnapshot): number {
  if (limit.until) return limit.until;
  const full = [snap?.limits.primary, snap?.limits.secondary]
    .filter((w): w is CodexWindow => !!w && w.used_percent >= 100)
    .map((w) => w.resets_at * 1000);
  return full.length ? Math.max(...full) : limit.at + 7 * 24 * 60 * 60_000;
}

// `attention`: the user should look (Codex is signed out, or its replies
// stopped reporting usage), as opposed to there simply being nothing to show
// yet. `limit`: the newest turn was refused because the usage limit is used
// up; `until` is when Codex said it resets (epoch ms).
export type CodexLimit = { until: number };
export type CodexStatus =
  | { ok: true; snap: CodexSnapshot; limit?: CodexLimit }
  | { ok: true; snap?: undefined; limit: CodexLimit }
  | { ok: false; hint: string; attention?: boolean };

// `live`: the latest reading from ChatGPT (codex-live.ts), if any. Whichever
// of it and the newest session-log snapshot is newer wins.
export async function readCodexStatus(now = Date.now(), live?: CodexSnapshot): Promise<CodexStatus> {
  const files = await recentSessionFiles();
  if (files.length === 0) return live ? { ok: true, snap: live } : { ok: false, hint: "NO SESSIONS" };
  const loginAt = await loginFileTime();
  if (loginAt === 0) return { ok: false, hint: "SIGN-IN", attention: true };
  const scan = await scanFiles(files);
  const { turnStarts, errors } = scan;
  const snap = live && (!scan.snap || live.at > scan.snap.at) ? live : scan.snap;
  const snapAt = snap?.at ?? 0;
  // Only errors after the newest snapshot say anything about now, and a
  // sign-in since a turn was refused for sign-in fixed that one (keyring
  // logins: can't tell).
  const newest = errors
    .filter((e) => e.at > snapAt && !(e.kind === "auth" && loginAt && loginAt > e.at))
    .sort((a, b) => b.at - a.at)[0];
  if (newest?.kind === "auth") return { ok: false, hint: "SIGN-IN", attention: true };
  if (stalledTurns(snapAt, turnStarts, now)) return { ok: false, hint: "CHECK CODEX", attention: true };
  if (newest?.kind === "limit") {
    const until = limitUntil(newest, snap);
    if (until > now) return snap ? { ok: true, snap, limit: { until } } : { ok: true, limit: { until } };
  }
  return snap ? { ok: true, snap } : { ok: false, hint: "NO DATA" };
}
