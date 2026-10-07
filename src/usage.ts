import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import streamDeck from "@elgato/streamdeck";
import {
  ACCOUNTS,
  credentialsFile,
  DEFAULT_ACCOUNT,
  keychainService,
  type Account,
} from "./accounts.js";
import { findBinary } from "./terminal.js";
import { needsAction } from "./tile-state.js";

// On macOS Claude Code keeps its OAuth credentials in the login Keychain
// instead of the JSON file. The first read may trigger a macOS "allow access"
// prompt; choose Always Allow. Generous timeout so that prompt can be answered.
const KEYCHAIN_TIMEOUT_MS = 120_000;
const execFileAsync = promisify(execFile);
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const REFRESH_URL = "https://console.anthropic.com/v1/oauth/token";
const BETA_HEADER = "oauth-2025-04-20";
const CACHE_TTL_MS = 3 * 60_000;
// A failure is cached briefly so keys ticking together share one attempt.
const FAILURE_TTL_MS = 60_000;
// While an account needs signing in, re-read its Keychain item this often
// (local only, no network) so a fresh sign-in shows up without a tap.
const SIGN_IN_POLL_MS = 20_000;
// Public OAuth client id used by Claude Code. Required field for refresh
// requests against console.anthropic.com.
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// When refresh fails with a real auth/format error, wait this long before
// trying again. Keeps a broken token from hammering the refresh endpoint
// and getting us 429'd. Network errors don't trigger a cooldown.
const REFRESH_FAILURE_COOLDOWN_MS = 15 * 60_000;
// If the last successful fetch was longer than this ago, assume the machine
// just woke from sleep and clear any active cooldown so we can recover fast.
const SLEEP_GAP_MS = 30 * 60_000;
// An expired Keychain token is renewed by running Claude Code (see
// renewViaClaudeCode). At most once per account per this window, so a
// broken login doesn't start Claude Code on every tick.
const RENEW_COOLDOWN_MS = 10 * 60_000;
const RENEW_TIMEOUT_MS = 30_000;
// Stream Deck starts the plugin with a minimal PATH, so look for Claude Code
// where its installers put it. Mid-update the npm launcher briefly vanishes,
// hence the package binary as a fallback.
const CLAUDE_BINARIES = [
  join(homedir(), ".npm-global/bin/claude"),
  join(homedir(), ".npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe"),
  join(homedir(), ".local/bin/claude"),
  join(homedir(), ".claude/local/claude"),
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
];

type Bucket = { utilization: number; resets_at: string | null } | null;

export type LimitKind = "session" | "weekly_all" | "weekly_scoped";

export type LimitEntry = {
  kind: LimitKind | string;
  group?: string;
  percent: number;
  severity?: string;
  resets_at: string | null;
  scope?: {
    model?: { id: string | null; display_name: string | null } | null;
    surface?: string | null;
  } | null;
  is_active?: boolean;
};

export type Spend = {
  used?: { amount_minor: number; currency: string; exponent: number } | null;
  limit?: { amount_minor: number; currency: string; exponent: number } | null;
  percent?: number | null;
  enabled?: boolean;
  disabled_reason?: string | null;
} | null;

export type ExtraUsage = {
  is_enabled: boolean;
  monthly_limit: number | null;
  used_credits: number | null;
  utilization: number | null;
  currency: string | null;
  decimal_places?: number | null;
} | null;

export type UsageResponse = {
  // Legacy top-level buckets. Session and weekly-all still populate; per-model
  // buckets (sonnet/opus/omelette) are now always null and superseded by
  // `limits[]` entries with kind: "weekly_scoped".
  five_hour: Bucket;
  seven_day: Bucket;
  seven_day_sonnet?: Bucket;
  seven_day_opus?: Bucket;
  seven_day_omelette?: Bucket;
  // New unified shape — one entry per active limit, self-describing.
  limits?: LimitEntry[];
  // Replaces extra_usage for spend/pay-as-you-go credit info.
  spend?: Spend;
  extra_usage?: ExtraUsage;
};

export function findLimit(
  data: UsageResponse,
  kind: LimitKind
): LimitEntry | undefined {
  return data.limits?.find((l) => l.kind === kind);
}

type Credentials = {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
};

type Ok<T> = { ok: true; data: T };
type Err = { ok: false; reason: string };
export type Result<T> = Ok<T> | Err;

// Everything below is per account: each login has its own token, its own
// rate limit and its own cache, so one account failing never blanks the other.
type AccountState = {
  cached?: { value: Result<UsageResponse>; fetchedAt: number };
  inflight?: Promise<Result<UsageResponse>>;
  refreshCooldownUntil: number;
  lastSuccessAt: number;
  renewAttemptAt: number;
  // While the account needs signing in: the token that failed (undefined if
  // there were no credentials at all) and the timer watching for a new one.
  signInWatch?: { failedToken?: string; timer: NodeJS.Timeout };
  // Access token the latest load used, for signInWatch.
  lastToken?: string;
  // Newest good response, kept so a tile can show it (marked old) through
  // a temporary failure instead of flipping to "!".
  lastGood?: UsageResponse;
};

const states = new Map<string, AccountState>();

function stateFor(account: Account): AccountState {
  let s = states.get(account.id);
  if (!s) {
    s = { refreshCooldownUntil: 0, lastSuccessAt: 0, renewAttemptAt: 0 };
    states.set(account.id, s);
  }
  return s;
}

// Where the credentials came from. Keychain credentials are read-only: the
// refresh token rotates on use, so refreshing here without writing back to the
// Keychain would leave Claude Code holding a dead refresh token (signed out).
// Claude Code refreshes its own token whenever it runs; we just re-read it.
type CredentialSource = "file" | "keychain";

async function readKeychainCredentials(account: Account): Promise<Credentials> {
  const { stdout } = await execFileAsync(
    "/usr/bin/security",
    ["find-generic-password", "-s", keychainService(account), "-w"],
    { timeout: KEYCHAIN_TIMEOUT_MS }
  );
  return JSON.parse(stdout.trim()) as Credentials;
}

async function readCredentials(
  account: Account
): Promise<{ creds: Credentials; source: CredentialSource }> {
  if (process.platform === "darwin") {
    try {
      return { creds: await readKeychainCredentials(account), source: "keychain" };
    } catch (e) {
      // Never log stdout/stderr here — on a parse failure it may hold the secret.
      const code = (e as { code?: unknown }).code;
      streamDeck.logger.warn(
        `usage[${account.id}]: keychain read failed (code ${String(code)}), trying file`
      );
    }
  }
  const raw = await readFile(credentialsFile(account), "utf8");
  return { creds: JSON.parse(raw) as Credentials, source: "file" };
}

export function findClaudeBinary(): Promise<string | undefined> {
  return findBinary(CLAUDE_BINARIES);
}

// Keychain tokens can't be refreshed here (see CredentialSource), but Claude
// Code can: `claude auth status` renews an expired token through Claude
// Code's own refresh-and-store path, so it keeps a live refresh token and
// stays signed in. Returns fresh Keychain credentials, or undefined if the
// renewal was throttled, Claude Code wasn't found, or it failed.
async function renewViaClaudeCode(account: Account): Promise<Credentials | undefined> {
  const state = stateFor(account);
  if (Date.now() - state.renewAttemptAt < RENEW_COOLDOWN_MS) return undefined;
  state.renewAttemptAt = Date.now();
  const bin = await findClaudeBinary();
  if (!bin) {
    streamDeck.logger.warn(`usage[${account.id}]: token expired and Claude Code not found to renew it`);
    return undefined;
  }
  // The default login must run without CLAUDE_CONFIG_DIR: setting it, even to
  // ~/.claude, makes Claude Code use a different Keychain item.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (account === DEFAULT_ACCOUNT) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = account.configDir;
  try {
    // Output is account metadata only (email, org, plan) and is discarded.
    await execFileAsync(bin, ["auth", "status"], { env, timeout: RENEW_TIMEOUT_MS });
    const creds = await readKeychainCredentials(account);
    // Claude Code exits 0 even when its refresh token is dead and it could
    // not renew, so check the result instead of trusting the exit code.
    if (isExpired(creds)) {
      streamDeck.logger.warn(`usage[${account.id}]: Claude Code ran but the token is still expired — sign in again`);
      return undefined;
    }
    streamDeck.logger.info(`usage[${account.id}]: renewed expired token via Claude Code`);
    return creds;
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    streamDeck.logger.warn(`usage[${account.id}]: Claude Code renewal failed (code ${String(code)})`);
    return undefined;
  }
}

function isExpired(creds: Credentials): boolean {
  return creds.claudeAiOauth.expiresAt - Date.now() < 60_000;
}

async function writeCredentials(account: Account, creds: Credentials): Promise<void> {
  await writeFile(credentialsFile(account), JSON.stringify(creds, null, 2), "utf8");
}

async function refreshAccessToken(account: Account, creds: Credentials): Promise<Credentials> {
  const state = stateFor(account);
  if (Date.now() < state.refreshCooldownUntil) {
    const wait = Math.round((state.refreshCooldownUntil - Date.now()) / 1000);
    throw new Error(`refresh on cooldown for ${wait}s — re-launch Claude Code to repair credentials`);
  }
  let res: Response;
  try {
    res = await fetch(REFRESH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: creds.claudeAiOauth.refreshToken,
        client_id: CLIENT_ID,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    // Network error / timeout — likely a transient post-wake hiccup.
    // Don't apply the long cooldown; let the next tick retry naturally.
    throw new Error(`refresh network error: ${(e as Error).message}`);
  }
  if (res.status >= 400 && res.status < 500) {
    // Genuine auth/format problem — cooldown is appropriate.
    state.refreshCooldownUntil = Date.now() + REFRESH_FAILURE_COOLDOWN_MS;
    throw new Error(`refresh failed: HTTP ${res.status} ${await res.text()}`);
  }
  if (!res.ok) {
    // 5xx — server-side blip, treat as transient (no cooldown).
    throw new Error(`refresh server error: HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  const updated: Credentials = {
    claudeAiOauth: {
      ...creds.claudeAiOauth,
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + body.expires_in * 1000,
    },
  };
  await writeCredentials(account, updated);
  state.refreshCooldownUntil = 0;
  streamDeck.logger.info(`usage[${account.id}]: refreshed OAuth access token`);
  return updated;
}

async function fetchOnce(token: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(USAGE_URL, {
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-beta": BETA_HEADER,
    },
    signal: AbortSignal.timeout(15_000),
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = await res.text();
  }
  return { status: res.status, body };
}

async function loadUsage(account: Account): Promise<Result<UsageResponse>> {
  let creds: Credentials;
  let source: CredentialSource;
  try {
    ({ creds, source } = await readCredentials(account));
  } catch (e) {
    return { ok: false, reason: `cannot read credentials: ${(e as Error).message}` };
  }

  const canRefresh = source === "file";
  const expired = isExpired(creds);
  stateFor(account).lastToken = creds.claudeAiOauth.accessToken;
  if (expired && !canRefresh) {
    const renewed = await renewViaClaudeCode(account);
    // Still expired: the API would only answer 401, so don't ask it.
    if (!renewed) return { ok: false, reason: "token expired — run Claude Code once to refresh it" };
    creds = renewed;
    stateFor(account).lastToken = creds.claudeAiOauth.accessToken;
  }
  if (expired && canRefresh) {
    try {
      creds = await refreshAccessToken(account, creds);
    } catch (e) {
      return { ok: false, reason: `refresh: ${(e as Error).message}` };
    }
  }

  let res = await fetchOnce(creds.claudeAiOauth.accessToken);
  if (res.status === 401 && !canRefresh) {
    const renewed = await renewViaClaudeCode(account);
    if (renewed) {
      creds = renewed;
      stateFor(account).lastToken = creds.claudeAiOauth.accessToken;
      res = await fetchOnce(creds.claudeAiOauth.accessToken);
    }
    if (res.status === 401) {
      return { ok: false, reason: "token expired — run Claude Code once to refresh it" };
    }
  }
  if (res.status === 401) {
    try {
      creds = await refreshAccessToken(account, creds);
      res = await fetchOnce(creds.claudeAiOauth.accessToken);
    } catch (e) {
      return { ok: false, reason: `401 then refresh: ${(e as Error).message}` };
    }
  }
  if (res.status === 429) {
    return { ok: false, reason: "rate_limited" };
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, reason: `HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}` };
  }
  return { ok: true, data: res.body as UsageResponse };
}

// Last good numbers for an account and when they arrived, if any.
export function lastGoodUsage(account: Account): { data: UsageResponse; at: number } | undefined {
  const state = stateFor(account);
  return state.lastGood ? { data: state.lastGood, at: state.lastSuccessAt } : undefined;
}

// Every finished fetch is announced so all keys showing that account redraw
// together, not just the key whose tick or tap asked for it.
type UsageListener = (account: Account, result: Result<UsageResponse>) => void;
const listeners = new Set<UsageListener>();

export function onUsageResult(listener: UsageListener): void {
  listeners.add(listener);
}

function announce(account: Account, result: Result<UsageResponse>): void {
  for (const listener of listeners) {
    try {
      listener(account, result);
    } catch (e) {
      streamDeck.logger.error(`usage[${account.id}]: listener failed: ${(e as Error).message}`);
    }
  }
}

// Redraw every key of the account from its latest result, without a fetch
// (e.g. to show "SIGNING IN" after a tap).
export function reannounce(account: Account): void {
  const value = stateFor(account).cached?.value;
  if (value) announce(account, value);
}

// While an account needs signing in, watch its credentials so signing in
// again updates every key within SIGN_IN_POLL_MS instead of waiting for the
// next tick (or a tap on each key).
function watchSignIn(account: Account, failed: boolean): void {
  const state = stateFor(account);
  if (!failed) {
    if (state.signInWatch) clearInterval(state.signInWatch.timer);
    state.signInWatch = undefined;
    return;
  }
  const failedToken = state.lastToken;
  if (state.signInWatch) {
    state.signInWatch.failedToken = failedToken;
    return;
  }
  const timer = setInterval(() => void checkSignIn(account), SIGN_IN_POLL_MS);
  timer.unref();
  state.signInWatch = { failedToken, timer };
}

// True while the account's latest result says it must be signed in again.
export function signInNeeded(account: Account): boolean {
  return stateFor(account).signInWatch !== undefined;
}

// One watcher pass: if the account's token changed since it failed, fetch
// straight away. Exported for scripts-check-usage.mjs.
export async function checkSignIn(account: Account): Promise<void> {
  const state = stateFor(account);
  const watch = state.signInWatch;
  if (!watch || state.inflight) return;
  let token: string;
  try {
    token = (await readCredentials(account)).creds.claudeAiOauth.accessToken;
  } catch {
    return; // still no credentials
  }
  if (token === watch.failedToken) return;
  streamDeck.logger.info(`usage[${account.id}]: new sign-in found, refreshing`);
  invalidateUsageCache(account);
  await getUsage(account);
}

export function invalidateUsageCache(account: Account): void {
  const state = stateFor(account);
  state.cached = undefined;
  state.refreshCooldownUntil = 0;
  // A tap is a deliberate retry, so let it renew straight away.
  state.renewAttemptAt = 0;
}

export async function getUsage(account: Account): Promise<Result<UsageResponse>> {
  const state = stateFor(account);
  const now = Date.now();
  // If the last good fetch was a long time ago we probably just woke from
  // sleep. Drop any active cooldown so the next call retries immediately.
  if (
    state.lastSuccessAt > 0 &&
    now - state.lastSuccessAt > SLEEP_GAP_MS &&
    state.refreshCooldownUntil > now
  ) {
    streamDeck.logger.info(`usage[${account.id}]: long gap since last success, clearing refresh cooldown`);
    state.refreshCooldownUntil = 0;
  }
  if (state.cached && now - state.cached.fetchedAt < CACHE_TTL_MS) return state.cached.value;
  if (state.inflight) return state.inflight;

  // A network error (e.g. right after wake) rejects fetch; report it as a
  // normal failure so callers always get a Result.
  const load = loadUsage(account).catch(
    (e: Error): Result<UsageResponse> => ({ ok: false, reason: `network error: ${e.message}` })
  );
  state.inflight = load.then((value) => {
    if (value.ok) {
      state.lastSuccessAt = Date.now();
      state.lastGood = value.data;
      state.cached = { value, fetchedAt: Date.now() };
    } else {
      // Cache the failure itself, briefly. Old numbers are never re-served
      // as a fresh success: tiles get them from lastGoodUsage, marked old,
      // and only when the failure is temporary.
      state.cached = { value, fetchedAt: Date.now() - CACHE_TTL_MS + FAILURE_TTL_MS };
    }
    watchSignIn(account, !value.ok && needsAction(value.reason));
    announce(account, value);
    return value;
  });

  try {
    return await state.inflight;
  } finally {
    state.inflight = undefined;
  }
}

export async function verifyUsage(): Promise<void> {
  await Promise.all(
    ACCOUNTS.map(async (account) => {
      const r = await getUsage(account);
      if (r.ok) {
        streamDeck.logger.info(`usage[${account.id}] probe ok (five_hour=${r.data.five_hour?.utilization})`);
      } else {
        streamDeck.logger.error(`usage[${account.id}] probe failed: ${r.reason}`);
      }
    })
  );
}
