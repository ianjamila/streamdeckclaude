// Checks src/usage.ts sign-in recovery with a fake Keychain, fake Claude Code
// and fake usage API: `node scripts-check-usage.mjs`. No network, no Keychain.
import { registerHooks } from "node:module";

const fake = {
  now: Date.parse("2026-10-07T00:00:00Z"),
  keychain: {}, // service -> credentials
  validTokens: new Set(),
  onAuthStatus: () => {}, // what `claude auth status` does
  fetches: 0,
  logs: [],
};
globalThis.__fake = fake;
Date.now = () => fake.now;
globalThis.fetch = async (_url, init) => {
  fake.fetches++;
  const token = init.headers.authorization.replace("Bearer ", "");
  const ok = fake.validTokens.has(token);
  return {
    status: ok ? 200 : 401,
    json: async () => (ok ? { five_hour: { utilization: 42, resets_at: null }, seven_day: null } : { error: "x" }),
    text: async () => "",
  };
};

const fakeModules = {
  "@elgato/streamdeck": `
    const log = (level) => (msg) => globalThis.__fake.logs.push(level + " " + msg);
    export default { logger: { info: log("info"), warn: log("warn"), error: log("error") } };`,
  "node:child_process": `
    import { promisify } from "node:util";
    export function execFile() { throw new Error("use promisified form"); }
    execFile[promisify.custom] = async (cmd, args) => {
      const f = globalThis.__fake;
      if (cmd === "/usr/bin/security") {
        const creds = f.keychain[args[2]];
        if (!creds) throw Object.assign(new Error("not found"), { code: 44 });
        return { stdout: JSON.stringify(creds) + "\\n", stderr: "" };
      }
      if (args[0] === "auth" && args[1] === "status") { f.onAuthStatus(); return { stdout: "", stderr: "" }; }
      throw new Error("unexpected exec " + cmd);
    };`,
};

// src/ imports siblings as "./x.js" (rollup output names); map them to the
// .ts sources, and swap the modules above for the fakes.
registerHooks({
  resolve(spec, ctx, next) {
    if (fakeModules[spec] !== undefined) {
      return { url: "data:text/javascript," + encodeURIComponent(fakeModules[spec]), shortCircuit: true };
    }
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith(".") && spec.endsWith(".js")) return next(spec.slice(0, -3) + ".ts", ctx);
      throw e;
    }
  },
});

Object.defineProperty(process, "platform", { value: "darwin" });
const usage = await import("./src/usage.ts");
const { ACCOUNTS } = await import("./src/accounts.ts");
const me = ACCOUNTS[0];
const SERVICE = "Claude Code-credentials";
const M = 60_000, H = 60 * M;

let fail = 0;
const expect = (name, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fail++;
    console.log("FAIL", name, "got", JSON.stringify(got), "want", JSON.stringify(want));
  }
};
const signIn = (token, ttl = 8 * H) => {
  fake.keychain[SERVICE] = { claudeAiOauth: { accessToken: token, refreshToken: "r-" + token, expiresAt: fake.now + ttl } };
  fake.validTokens.add(token);
};
const heard = [];
if (typeof usage.onUsageResult === "function") usage.onUsageResult((account, r) => heard.push([account.id, r.ok]));
else { fail++; console.log("FAIL onUsageResult is not exported"); }

// 1. Signed in: fetch works and every key of the account hears about it.
signIn("t1");
let r = await usage.getUsage(me);
expect("signed in: ok", r.ok, true);
expect("signed in: broadcast", heard.splice(0), [["me", true]]);
await usage.getUsage(me);
expect("cache hit: no fetch, no broadcast", [fake.fetches, heard.length], [1, 0]);

// 2. Token expires and Claude Code can't renew it (dead refresh token).
fake.now += 9 * H;
fake.validTokens.delete("t1");
fake.fetches = 0;
fake.logs.length = 0;
r = await usage.getUsage(me);
expect("dead login: SIGN-IN reason", r.ok ? "ok" : r.reason.startsWith("token expired"), true);
expect("dead login: no false 'renewed' log", fake.logs.some((l) => l.includes("renewed")), false);
expect("dead login: says renewal failed", fake.logs.some((l) => l.startsWith("warn") && l.includes("still expired")), true);
expect("dead login: no doomed fetch with an expired token", fake.fetches, 0);
expect("dead login: broadcast failure", heard.splice(0), [["me", false]]);

// 3. Another key ticks 10s later: it must see the failure too, not the
// 9-hour-old numbers dressed up as a fresh success.
fake.now += 10_000;
r = await usage.getUsage(me);
expect("sibling tick after failure: not ok", r.ok, false);

// 4. Nothing changed in the Keychain: the sign-in watcher stays quiet.
fake.fetches = 0;
if (typeof usage.checkSignIn === "function") {
  await usage.checkSignIn(me);
  expect("watcher, same token: no fetch", fake.fetches, 0);
  expect("watcher, same token: no broadcast", heard.length, 0);

  // 5. User signs in again: the watcher spots the new token and every key
  // of the account updates without a tap.
  signIn("t2");
  fake.now += 20_000;
  await usage.checkSignIn(me);
  expect("watcher, new token: fetched", fake.fetches, 1);
  expect("watcher, new token: broadcast ok", heard.splice(0), [["me", true]]);
  r = await usage.getUsage(me);
  expect("after sign-in: ok from cache", [r.ok, fake.fetches], [true, 1]);
  const good = usage.lastGoodUsage(me);
  expect("after sign-in: last good is now", good?.at, fake.now);
} else {
  fail++;
  console.log("FAIL checkSignIn is not exported");
}

// 6. Normal expiry with a live refresh token: Claude Code renews it.
fake.now += 9 * H;
fake.validTokens.clear();
fake.onAuthStatus = () => signIn("t3");
fake.logs.length = 0;
usage.invalidateUsageCache(me);
r = await usage.getUsage(me);
expect("renewal works: ok", r.ok, true);
expect("renewal works: logged", fake.logs.some((l) => l.includes("renewed expired token")), true);

console.log(fail ? `${fail} FAILED` : "all usage checks passed");
process.exit(fail ? 1 : 0);
