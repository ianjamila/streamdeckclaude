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

// The window a tap on a CHECK CODEX key opens.
const { codexCheckScript } = await import("./src/codex-check.ts");
const { execFileSync } = await import("node:child_process");
const script = codexCheckScript("/x/it's codex");
expect("check: runs login status", script.includes("'/x/it'\\''s codex' login status"), true);
expect("check: offers codex login", script.includes("then echo; '/x/it'\\''s codex' login; fi"), true);
const scriptFile = join(home, "check.command");
writeFileSync(scriptFile, script);
expect("check: zsh -n", (() => { try { execFileSync("/bin/zsh", ["-n", scriptFile]); return true; } catch { return false; } })(), true);

console.log(fail ? `${fail} FAILED` : "all codex checks passed");
process.exit(fail ? 1 : 0);
