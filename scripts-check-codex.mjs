// Checks src/codex.ts. Real run: `node scripts-check-codex.mjs`.
// Synthetic run uses a temp CODEX_HOME (set before import).
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";

// src/ imports siblings as "./x.js" (rollup output names); map them to the .ts sources.
registerHooks({
  resolve(spec, ctx, next) {
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith(".") && spec.endsWith(".js")) return next(spec.slice(0, -3) + ".ts", ctx);
      throw e;
    }
  },
});

const synthetic = process.argv[2] === "synthetic";
let home;
if (synthetic) {
  home = mkdtempSync(join(tmpdir(), "codex-check-"));
  process.env.CODEX_HOME = home;
  writeFileSync(join(home, "auth.json"), "{}"); // signed in
}
const m = await import("./src/codex.ts");
let fail = 0;
const expect = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) { fail++; console.log("FAIL", name, "got", got, "want", want); } };

if (!synthetic) {
  const s = await m.readCodexSnapshot();
  if (!s) { console.log("no snapshot found"); process.exit(1); }
  const w = m.findWindow(s.limits, "weekly");
  console.log("real: at", new Date(s.at).toISOString(), "| weekly", w && `${m.effectivePercent(w)}% ${m.windowLabel(w)} resets ${new Date(w.resets_at*1000).toISOString()}`, "| short", m.findWindow(s.limits, "short") ? "yes" : "none", "| stale", m.staleTag(s.at) ?? "no");
  process.exit(0);
}

const nowS = Math.floor(Date.now() / 1000);
const ev = (ts, primary, secondary) => JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "token_count", rate_limits: { primary, secondary, plan_type: "plus" } } });
const day = join(home, "sessions", "2026", "10", "05"); mkdirSync(day, { recursive: true });
const older = join(home, "sessions", "2026", "10", "04"); mkdirSync(older, { recursive: true });
// File A: newest mtime but OLDER snapshot timestamp; File B: newer snapshot (parallel session).
const pad = "x".repeat(700 * 1024); // forces the tail read to start mid-file
writeFileSync(join(day, "rollout-a.jsonl"), [JSON.stringify({ pad }), ev("2026-10-05T08:00:00Z", { used_percent: 10, window_minutes: 300, resets_at: nowS + 3600 }, { used_percent: 40, window_minutes: 10080, resets_at: nowS + 86400 }), JSON.stringify({ timestamp: "2026-10-05T08:00:01Z", type: "response_item" })].join("\n") + "\n");
writeFileSync(join(day, "rollout-b.jsonl"), ev("2026-10-05T09:00:00Z", { used_percent: 55, window_minutes: 300, resets_at: nowS - 60 }, { used_percent: 61, window_minutes: 10080, resets_at: nowS + 86400 }) + "\n");
writeFileSync(join(older, "rollout-c.jsonl"), ev("2026-10-04T09:00:00Z", { used_percent: 99, window_minutes: 300, resets_at: nowS + 60 }, null) + "\n");
const t = Date.now() / 1000; utimesSync(join(day, "rollout-a.jsonl"), t, t); utimesSync(join(day, "rollout-b.jsonl"), t - 10, t - 10);

const s = await m.readCodexSnapshot();
expect("picks newest snapshot across files", s && new Date(s.at).toISOString(), "2026-10-05T09:00:00.000Z");
const short = m.findWindow(s.limits, "short"), weekly = m.findWindow(s.limits, "weekly");
expect("short label", m.windowLabel(short), "5H");
expect("weekly label", m.windowLabel(weekly), "7D");
expect("passed reset reads 0%", m.effectivePercent(short), 0);
expect("weekly percent", m.effectivePercent(weekly), 61);
expect("missing window", m.findWindow({ primary: weekly, secondary: null }, "short"), undefined);
const st = await m.readCodexStatus();
expect("status ok with snapshot", st.ok && new Date(st.snap.at).toISOString(), "2026-10-05T09:00:00.000Z");
const H = 3600_000, now0 = Date.parse("2026-10-06T12:00:00Z");
expect("fresh: no stale tag", m.staleTag(now0 - 23 * H, now0), undefined);
expect("exactly a day: 1D OLD", m.staleTag(now0 - 24 * H, now0), "1D OLD");
expect("47h: still 1D OLD", m.staleTag(now0 - 47 * H, now0), "1D OLD");
expect("3 days: 3D OLD", m.staleTag(now0 - 72 * H, now0), "3D OLD");
expect("a week+: 7D+ OLD", m.staleTag(now0 - 200 * H, now0), "7D+ OLD");
expect("no timestamp: no tag", m.staleTag(0, now0), undefined);
// Codex is used but its replies stop reporting usage: 2+ turns started more
// than 10 min ago, after the newest snapshot, with no usage since.
const M = 60_000, snapAt = now0 - 3 * H;
expect("no turns: fine", m.stalledTurns(snapAt, [], now0), false);
expect("one silent turn (e.g. quit mid-reply): fine", m.stalledTurns(snapAt, [now0 - 30 * M], now0), false);
expect("two silent turns: stalled", m.stalledTurns(snapAt, [now0 - 30 * M, now0 - 20 * M], now0), true);
expect("second turn under 10 min old: not yet", m.stalledTurns(snapAt, [now0 - 30 * M, now0 - 9 * M], now0), false);
expect("turns before the snapshot don't count", m.stalledTurns(snapAt, [now0 - 4 * H, now0 - 5 * H, now0 - 30 * M], now0), false);
expect("never any snapshot: turns count", m.stalledTurns(0, [now0 - 30 * M, now0 - 20 * M], now0), true);

// End to end on files: a newer session with two turns that never reported.
const turn = (ms) => JSON.stringify({ timestamp: new Date(ms).toISOString(), type: "event_msg", payload: { type: "task_started" } });
const today = join(home, "sessions", "2026", "10", "06"); mkdirSync(today, { recursive: true });
const realNow = Date.now();
writeFileSync(join(today, "rollout-d.jsonl"), [turn(realNow - 40 * M), turn(realNow - 25 * M)].join("\n") + "\n");
let st2 = await m.readCodexStatus();
expect("files: stalled → CHECK CODEX", [st2.ok, st2.hint, st2.attention], [false, "CHECK CODEX", true]);
// Codex replies again: a fresh snapshot clears it.
writeFileSync(join(today, "rollout-d.jsonl"), [turn(realNow - 40 * M), turn(realNow - 25 * M), turn(realNow - 2 * M), ev(new Date(realNow - M).toISOString(), { used_percent: 12, window_minutes: 10080, resets_at: nowS + 86400 }, null)].join("\n") + "\n");
st2 = await m.readCodexStatus();
expect("files: replies again → ok", st2.ok, true);

// Turns Codex refused: usage limit used up, or signed out (2026-10-09: four
// refused turns read as "CHECK CODEX" and hid the 100%).
const LIMIT_MSG = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 14th, 2026 11:29 AM.";
expect("reset: full date (local time)", m.limitResetFrom(LIMIT_MSG, now0), new Date(2026, 9, 14, 11, 29).getTime());
const errAt = new Date(2026, 9, 9, 10, 0).getTime();
expect("reset: time only, later today", m.limitResetFrom("try again at 3:05 PM.", errAt), new Date(2026, 9, 9, 15, 5).getTime());
expect("reset: time only, already passed → tomorrow", m.limitResetFrom("try again at 9:00 AM.", errAt), new Date(2026, 9, 10, 9, 0).getTime());
expect("reset: 12 AM is midnight", m.limitResetFrom("try again at Oct 14th, 2026 12:15 AM.", errAt), new Date(2026, 9, 14, 0, 15).getTime());
expect("reset: no time given", m.limitResetFrom("You've hit your usage limit.", errAt), undefined);
expect("classify: usage limit", m.classifyTurnError({ codex_error_info: "usage_limit_exceeded", message: LIMIT_MSG }, now0)?.kind, "limit");
expect("classify: 401 is sign-in", m.classifyTurnError({ codex_error_info: "other", message: "unexpected status 401 Unauthorized: Missing bearer" }, now0)?.kind, "auth");
expect("classify: overloaded isn't explained", m.classifyTurnError({ codex_error_info: "server_overloaded", message: "try later" }, now0), undefined);
const snapW = { limits: { primary: { used_percent: 100, window_minutes: 10080, resets_at: 2_000_000_000 }, secondary: null }, at: 1 };
expect("until: falls back to the used-up window", m.limitUntil({ kind: "limit", at: 5 }, snapW), 2_000_000_000_000);
expect("until: else a week", m.limitUntil({ kind: "limit", at: 5 }, undefined), 5 + 7 * 24 * H);

const refused = (ms, id, error) => [
  JSON.stringify({ timestamp: new Date(ms).toISOString(), type: "event_msg", payload: { type: "task_started", turn_id: id } }),
  JSON.stringify({ timestamp: new Date(ms + 5000).toISOString(), type: "event_msg", payload: { type: "token_count", info: null, rate_limits: { primary: null, secondary: null, credits: { has_credits: false } } } }),
  JSON.stringify({ timestamp: new Date(ms + 5000).toISOString(), type: "event_msg", payload: { type: "task_complete", turn_id: id, error } }),
].join("\n");
const later = join(home, "sessions", "2026", "10", "07"); mkdirSync(later, { recursive: true });
// The newest usage snapshot is an hour old; the refused turns come after it.
writeFileSync(join(today, "rollout-d.jsonl"), ev(new Date(realNow - 60 * M).toISOString(), { used_percent: 100, window_minutes: 10080, resets_at: nowS + 86400 }, null) + "\n");
const limitErr = { codex_error_info: "usage_limit_exceeded", message: "You've hit your usage limit. try again at Dec 31st, 2099 11:29 AM." };
writeFileSync(join(later, "rollout-e.jsonl"), [refused(realNow - 50 * M, "t1", limitErr), refused(realNow - 30 * M, "t2", limitErr), refused(realNow - 20 * M, "t3", limitErr)].join("\n") + "\n");
let st3 = await m.readCodexStatus();
expect("files: refused for limit → 100% until reset, not CHECK CODEX", [st3.ok, st3.limit?.until, st3.snap?.at > 0], [true, new Date(2099, 11, 31, 11, 29).getTime(), true]);
expect("files: limit over → back to the snapshot", (await m.readCodexStatus(new Date(2100, 0, 1).getTime())).limit, undefined);
// Turns that failed for other reasons still count as silent.
writeFileSync(join(later, "rollout-e.jsonl"), [refused(realNow - 50 * M, "t1", limitErr), refused(realNow - 30 * M, "t4", { codex_error_info: "server_overloaded", message: "x" }), refused(realNow - 20 * M, "t5", { codex_error_info: "other", message: "stream disconnected" })].join("\n") + "\n");
st3 = await m.readCodexStatus();
expect("files: unexplained failures → CHECK CODEX", [st3.ok, st3.hint], [false, "CHECK CODEX"]);
// Refused for sign-in: SIGN-IN until auth.json changes after the refusal.
writeFileSync(join(later, "rollout-e.jsonl"), refused(realNow - 20 * M, "t6", { codex_error_info: "other", message: "unexpected status 401 Unauthorized" }) + "\n");
utimesSync(join(home, "auth.json"), (realNow - 60 * M) / 1000, (realNow - 60 * M) / 1000);
st3 = await m.readCodexStatus();
expect("files: 401 → SIGN-IN", [st3.ok, st3.hint, st3.attention], [false, "SIGN-IN", true]);
utimesSync(join(home, "auth.json"), (realNow - M) / 1000, (realNow - M) / 1000);
expect("files: signed in since → ok", (await m.readCodexStatus()).ok, true);
// Signed in again after a limit refusal then a 401: the limit still shows.
writeFileSync(join(later, "rollout-e.jsonl"), [refused(realNow - 30 * M, "t8", limitErr), refused(realNow - 20 * M, "t9", { codex_error_info: "other", message: "unexpected status 401 Unauthorized" })].join("\n") + "\n");
expect("files: sign-in clears the 401, not the limit", (await m.readCodexStatus()).limit?.until, new Date(2099, 11, 31, 11, 29).getTime());
// No login file at all (and no refused turns to go by).
writeFileSync(join(later, "rollout-e.jsonl"), "\n");
const { rmSync } = await import("node:fs");
rmSync(join(home, "auth.json"));
st3 = await m.readCodexStatus();
expect("no auth.json → SIGN-IN", [st3.ok, st3.hint, st3.attention], [false, "SIGN-IN", true]);
writeFileSync(join(home, "config.toml"), 'model = "x"\ncli_auth_credentials_store = "keyring"\n');
expect("keyring login: missing auth.json says nothing", (await m.readCodexStatus()).ok, true);
writeFileSync(join(later, "rollout-e.jsonl"), refused(realNow - 20 * M, "t7", { codex_error_info: "other", message: "unexpected status 401 Unauthorized" }) + "\n");
expect("keyring login: a 401 still means signed out", (await m.readCodexStatus()).hint, "SIGN-IN");

// Live reading from ChatGPT (codex-live.ts): read-only use of Codex's login.
const live = await import("./src/codex-live.ts");
writeFileSync(join(home, "config.toml"), 'model = "x"\n');
const jwt = (expMs) => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) })).toString("base64url")}.s`;
const login = (o) => writeFileSync(join(home, "auth.json"), JSON.stringify(o));
login({ auth_mode: "chatgpt", tokens: { access_token: jwt(realNow + 24 * H), account_id: "acct-1", refresh_token: "r" } });
expect("login: valid ChatGPT token", (await live.readCodexLogin())?.accountId, "acct-1");
login({ auth_mode: "chatgpt", tokens: { access_token: jwt(realNow + 30_000), account_id: "acct-1" } });
expect("login: expiring token is skipped (never refreshed)", await live.readCodexLogin(), undefined);
login({ auth_mode: "apikey", OPENAI_API_KEY: "k", tokens: { access_token: jwt(realNow + 24 * H) } });
expect("login: API-key login has no ChatGPT usage", await live.readCodexLogin(), undefined);
login({});
expect("login: empty", await live.readCodexLogin(), undefined);
login({ auth_mode: "chatgpt", tokens: { access_token: jwt(realNow + 24 * H), account_id: "acct-1" } });
writeFileSync(join(home, "config.toml"), 'cli_auth_credentials_store = "keyring"\n');
expect("login: keyring store → not read", await live.readCodexLogin(), undefined);
writeFileSync(join(home, "config.toml"), 'model = "x"\n');

// Reply shape seen 2026-10-09 (prolite: weekly window only).
const body = { plan_type: "prolite", rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 7, limit_window_seconds: 604800, reset_after_seconds: 1000, reset_at: nowS + 1000 }, secondary_window: null }, rate_limit_reached_type: null };
const ls = live.liveSnapshot(body, 123);
expect("live: weekly window mapped", [m.windowLabel(m.findWindow(ls.limits, "weekly")), m.findWindow(ls.limits, "weekly").used_percent, ls.limits.primary.resets_at, ls.at], ["7D", 7, nowS + 1000, 123]);
expect("live: no 5h window", m.findWindow(ls.limits, "short"), undefined);
expect("live: limit_reached flag kept", live.liveSnapshot({ ...body, rate_limit: { ...body.rate_limit, limit_reached: true } }, 1).limits.rate_limit_reached_type, "limit");
expect("live: no windows → nothing", live.liveSnapshot({ rate_limit: { primary_window: null, secondary_window: null } }, 1), undefined);

let seen;
const fakeFetch = (status, json, thrown) => async (url, init) => { seen = { url, init }; if (thrown) throw new Error(thrown); return { ok: status === 200, status, json: async () => json }; };
let lr = await live.fetchCodexLive(fakeFetch(200, body));
expect("fetch: ok", lr.ok && m.findWindow(lr.snap.limits, "weekly").used_percent, 7);
expect("fetch: bearer + account headers, usage URL", [seen.url, seen.init.headers.Authorization.startsWith("Bearer h."), seen.init.headers["ChatGPT-Account-Id"]], ["https://chatgpt.com/backend-api/wham/usage", true, "acct-1"]);
expect("fetch: 401", (await live.fetchCodexLive(fakeFetch(401, {}))).reason, "HTTP 401");
expect("fetch: offline", (await live.fetchCodexLive(fakeFetch(0, null, "fetch failed"))).reason, "fetch failed");
login({});
seen = undefined;
expect("fetch: no login → no request", [(await live.fetchCodexLive(fakeFetch(200, body))).ok, seen], [false, undefined]);

// Shared cache: every 5 min, retry 2 min after a failure, a tap after 15s.
let calls = 0, answer = { ok: true, snap: ls };
const cache = live.createLiveCache(async () => { calls++; return answer; });
const t0 = 1_000_000;
let g = await cache.get(t0);
expect("cache: first ask", [calls, g.snap?.at, g.changedReason], [1, 123, true]);
await cache.get(t0 + 60_000);
expect("cache: not again within 5 min", calls, 1);
await cache.get(t0 + 10_000, true);
expect("cache: tap within 15s doesn't ask", calls, 1);
await cache.get(t0 + 20_000, true);
expect("cache: tap after 15s asks", calls, 2);
answer = { ok: false, reason: "HTTP 500" };
g = await cache.get(t0 + 20_000 + 5 * 60_000);
expect("cache: failure keeps last good reading", [calls, g.snap?.at, g.reason, g.changedReason], [3, 123, "HTTP 500", true]);
await cache.get(t0 + 20_000 + 6 * 60_000);
expect("cache: no retry within 2 min", calls, 3);
await cache.get(t0 + 20_000 + 7 * 60_000 + 1);
expect("cache: retry after 2 min", calls, 4);

// Status: a live reading newer than the refused turns shows the reset;
// an older one gives way to the session logs.
login({ auth_mode: "chatgpt", tokens: { access_token: jwt(realNow + 24 * H) } });
writeFileSync(join(later, "rollout-e.jsonl"), [refused(realNow - 30 * M, "t10", limitErr), refused(realNow - 20 * M, "t11", limitErr)].join("\n") + "\n");
expect("status: limit without live", (await m.readCodexStatus()).limit?.until > 0, true);
const fresh = live.liveSnapshot(body, realNow);
const st4 = await m.readCodexStatus(realNow, fresh);
expect("status: newer live reading clears the limit", [st4.ok, st4.limit, st4.snap?.at], [true, undefined, realNow]);
const oldLive = live.liveSnapshot(body, realNow - 2 * H);
const st5 = await m.readCodexStatus(realNow, oldLive);
expect("status: older live reading gives way", [st5.limit?.until > 0, st5.snap?.at], [true, realNow - 60 * M]);

console.log(fail ? `${fail} FAILED` : "all codex checks passed");
process.exit(fail ? 1 : 0);
