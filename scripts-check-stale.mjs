// Checks src/tile-state.ts + src/age.ts: `node scripts-check-stale.mjs`.
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

const { ageTag } = await import("./src/age.ts");
const { tileState, errorHint, needsAction } = await import("./src/tile-state.ts");
let fail = 0;
const expect = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) { fail++; console.log("FAIL", name, "got", JSON.stringify(got), "want", JSON.stringify(want)); } };

const M = 60_000, H = 60 * M, D = 24 * H;
expect("age 30s", ageTag(30_000), "1M OLD");
expect("age 20m", ageTag(20 * M), "20M OLD");
expect("age 59m", ageTag(59 * M + 59_000), "59M OLD");
expect("age 1h", ageTag(H), "1H OLD");
expect("age 23h", ageTag(23 * H + 59 * M), "23H OLD");
expect("age 1d", ageTag(D), "1D OLD");
expect("age 6d", ageTag(6 * D + 23 * H), "6D OLD");
expect("age 7d", ageTag(7 * D), "7D+ OLD");

expect("hint expired", errorHint("token expired — run Claude Code once to refresh it"), "SIGN-IN");
expect("hint refresh 4xx", errorHint("refresh: refresh failed: HTTP 400 bad"), "SIGN-IN");
expect("hint refresh network", errorHint("refresh: refresh network error: fetch failed"), "OFFLINE");
expect("hint refresh 5xx", errorHint("refresh: refresh server error: HTTP 502"), "ERROR");
expect("hint network", errorHint("network error: fetch failed"), "OFFLINE");
expect("hint rate", errorHint("rate_limited"), "RATE LIMIT");
expect("hint no login", errorHint("cannot read credentials: ENOENT"), "NO LOGIN");
expect("hint other", errorHint("HTTP 500: {}"), "ERROR");
expect("action sign-in", needsAction("token expired — x"), true);
expect("action offline", needsAction("network error: x"), false);

const now = Date.parse("2026-10-06T12:00:00Z");
const data = { five_hour: { utilization: 42 } };
const old = { five_hour: { utilization: 7 } };
const ok = { ok: true, data };
const offline = { ok: false, reason: "network error: fetch failed" };
const expired = { ok: false, reason: "token expired — run Claude Code once to refresh it" };

expect("fresh ok", tileState(ok, { data, at: now - 3 * M }, now), { kind: "data", data });
expect("ok, first ever (no good yet)", tileState(ok, undefined, now), { kind: "data", data });
expect("ok exactly 15m: not old", tileState(ok, { data, at: now - 15 * M }, now), { kind: "data", data });
expect("cached ok but last success 20m ago", tileState(ok, { data, at: now - 20 * M }, now), { kind: "data", data, stale: "20M OLD" });
expect("offline, good 5m ago: data, no tag", tileState(offline, { data: old, at: now - 5 * M }, now), { kind: "data", data: old });
expect("offline, good 2h ago: data + 2H OLD", tileState(offline, { data: old, at: now - 2 * H }, now), { kind: "data", data: old, stale: "2H OLD" });
expect("offline, never good: OFFLINE", tileState(offline, undefined, now), { kind: "error", hint: "OFFLINE" });
expect("rate limited keeps data", tileState({ ok: false, reason: "rate_limited" }, { data: old, at: now - 30 * M }, now), { kind: "data", data: old, stale: "30M OLD" });
expect("expired shows SIGN-IN despite good data", tileState(expired, { data: old, at: now - 1 * M }, now), { kind: "error", hint: "SIGN-IN" });

console.log(fail ? `${fail} FAILED` : "all stale checks passed");
process.exit(fail ? 1 : 0);
