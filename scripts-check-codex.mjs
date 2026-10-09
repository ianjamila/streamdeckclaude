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

console.log(fail ? `${fail} FAILED` : "all codex checks passed");
process.exit(fail ? 1 : 0);
