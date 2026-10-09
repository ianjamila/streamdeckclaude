import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CodexRateLimits, CodexSnapshot, CodexWindow } from "./codex.js";

// Live Codex usage from ChatGPT: the same endpoint Codex's own /usage command
// reads, so a limit reset, bought credits, or use on another device shows up
// without waiting for the next local Codex turn. Uses Codex's saved login
// READ-ONLY: never refreshes it (refresh tokens rotate, so refreshing here
// would sign Codex out). An expired access token is skipped until Codex
// refreshes it on its next run. No Stream Deck imports, so it can be checked
// with plain node.

const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const TIMEOUT_MS = 10_000;
// How often to ask ChatGPT (the local session logs are still read every tick).
export const LIVE_EVERY_MS = 5 * 60_000;
export const LIVE_RETRY_MS = 2 * 60_000;
// A tap asks again, but not more often than this.
export const LIVE_MIN_GAP_MS = 15_000;

export type CodexLogin = { token: string; accountId?: string };

function jwtExpiry(token: string): number | undefined {
  try {
    const exp = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")).exp;
    return typeof exp === "number" ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

// The ChatGPT login Codex saved in auth.json, or undefined: none, an API-key
// login (no ChatGPT usage), a keyring login (config.toml), or an access token
// within a minute of expiring.
export async function readCodexLogin(now = Date.now()): Promise<CodexLogin | undefined> {
  const config = await readFile(join(CODEX_HOME, "config.toml"), "utf8").catch(() => "");
  if (/^\s*cli_auth_credentials_store\s*=\s*["']keyring["']/m.test(config)) return undefined;
  let auth: { auth_mode?: string; tokens?: { access_token?: unknown; account_id?: unknown } };
  try {
    auth = JSON.parse(await readFile(join(CODEX_HOME, "auth.json"), "utf8"));
  } catch {
    return undefined;
  }
  const token = auth.tokens?.access_token;
  if (typeof token !== "string" || !token) return undefined;
  if (auth.auth_mode && auth.auth_mode !== "chatgpt") return undefined;
  const exp = jwtExpiry(token);
  if (exp !== undefined && exp - 60_000 <= now) return undefined;
  const accountId = typeof auth.tokens?.account_id === "string" ? auth.tokens.account_id : undefined;
  return { token, accountId };
}

type LiveWindow = { used_percent?: unknown; limit_window_seconds?: unknown; reset_at?: unknown } | null | undefined;

function toWindow(w: LiveWindow): CodexWindow | null {
  if (!w) return null;
  const used = Number(w.used_percent), secs = Number(w.limit_window_seconds), reset = Number(w.reset_at);
  if (![used, secs, reset].every(Number.isFinite) || secs <= 0) return null;
  return { used_percent: used, window_minutes: Math.round(secs / 60), resets_at: reset };
}

// The /wham/usage reply in the shape the session logs use, or undefined when
// it has no usage windows.
export function liveSnapshot(body: unknown, at: number): CodexSnapshot | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as {
    plan_type?: unknown;
    rate_limit_reached_type?: unknown;
    rate_limit?: { limit_reached?: unknown; primary_window?: LiveWindow; secondary_window?: LiveWindow } | null;
  };
  const primary = toWindow(b.rate_limit?.primary_window);
  const secondary = toWindow(b.rate_limit?.secondary_window);
  if (!primary && !secondary) return undefined;
  const reached =
    typeof b.rate_limit_reached_type === "string" ? b.rate_limit_reached_type : b.rate_limit?.limit_reached === true ? "limit" : null;
  const limits: CodexRateLimits = {
    primary,
    secondary,
    plan_type: typeof b.plan_type === "string" ? b.plan_type : null,
    rate_limit_reached_type: reached,
  };
  return { limits, at };
}

export type LiveResult = { ok: true; snap: CodexSnapshot } | { ok: false; reason: string };

export async function fetchCodexLive(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<LiveResult> {
  const login = await readCodexLogin(now);
  if (!login) return { ok: false, reason: "no usable Codex login" };
  const headers: Record<string, string> = {
    Authorization: `Bearer ${login.token}`,
    "User-Agent": "claude-usage-streamdeck",
  };
  if (login.accountId) headers["ChatGPT-Account-Id"] = login.accountId;
  try {
    const res = await fetchImpl(USAGE_URL, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const snap = liveSnapshot(await res.json(), now);
    return snap ? { ok: true, snap } : { ok: false, reason: "no usage windows in reply" };
  } catch (e) {
    return { ok: false, reason: (e as Error).message || "network error" };
  }
}

// One shared live reading for all Codex keys: asks at most every
// LIVE_EVERY_MS (LIVE_RETRY_MS after a failure, LIVE_MIN_GAP_MS when forced
// by a tap) and returns the last good snapshot. Readers compare its `at`
// with the session logs, so an old live reading gives way to newer local ones.
export function createLiveCache(fetchLive: (now: number) => Promise<LiveResult> = (now) => fetchCodexLive(fetch, now)) {
  let last: CodexSnapshot | undefined;
  let askedAt = -Infinity;
  let failed = false;
  let inFlight: Promise<void> | undefined;
  // null until the first answer, so the first one counts as a change (logged).
  let lastReason: string | undefined | null = null;
  return {
    async get(now = Date.now(), force = false): Promise<{ snap?: CodexSnapshot; reason?: string; changedReason?: boolean }> {
      const wait = force ? LIVE_MIN_GAP_MS : failed ? LIVE_RETRY_MS : LIVE_EVERY_MS;
      let changedReason = false;
      if (!inFlight && now - askedAt >= wait) {
        askedAt = now;
        inFlight = fetchLive(now).then((r) => {
          failed = !r.ok;
          if (r.ok) last = r.snap;
          const reason = r.ok ? undefined : r.reason;
          changedReason = reason !== lastReason;
          lastReason = reason;
        });
      }
      if (inFlight) {
        await inFlight;
        inFlight = undefined;
      }
      return { snap: last, reason: lastReason ?? undefined, changedReason };
    },
  };
}
