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
  opened: [], // args of each /usr/bin/open call
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
      if (cmd === "/usr/bin/open") { f.opened.push(args); return { stdout: "", stderr: "" }; }
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
const signInMod = await import("./src/sign-in.ts").catch((e) => ({ loadError: e }));
const me = ACCOUNTS[0];
const ew = ACCOUNTS[1];
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
expect("dead login: sign-in needed", usage.signInNeeded?.(me), true);
expect("other account unaffected", usage.signInNeeded?.(ew), false);

// 2b. Tapping the key now opens Terminal on a sign-in script for that
// account (not the usage page), and a double tap doesn't open two.
if (signInMod.loadError) {
  fail++;
  console.log("FAIL src/sign-in.ts:", signInMod.loadError.message);
} else {
  const { openSignIn, signInScript, signingIn } = signInMod;
  const { execFileSync } = await import("child_process"); // real one: the fake is keyed "node:child_process"
  const { readFileSync, statSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  expect("tap opens sign-in", await openSignIn(me), true);
  expect("one open call", fake.opened.length, 1);
  const file = fake.opened[0]?.[0] ?? "";
  expect("opens a .command file", file.endsWith(".command"), true);
  const script = readFileSync(file, "utf8");
  expect("script is executable", (statSync(file).mode & 0o100) !== 0, true);
  expect("ME: runs login with ME email", script.includes("auth login --claudeai --email 'jamilaian21@gmail.com'"), true);
  expect("ME: default config dir (unset)", script.includes("unset CLAUDE_CONFIG_DIR"), true);
  // The sign-in page opens in the account's Chrome profile: BROWSER points
  // at a helper that opens Chrome on that profile.
  const browserLine = script.split("\n").find((l) => l.startsWith("export BROWSER=")) ?? "";
  const helper = browserLine.replace(/^export BROWSER='(.*)'$/, "$1");
  expect("ME: BROWSER set to a helper", helper.endsWith("claude-usage-browser-me"), true);
  const helperText = (() => { try { return readFileSync(helper, "utf8"); } catch { return ""; } })();
  expect("helper is executable", helperText ? (statSync(helper).mode & 0o100) !== 0 : false, true);
  expect("helper opens Chrome on ME's profile", /'--profile-(directory=Profile \d+|email=jamilaian21@gmail\.com)'/.test(helperText), true);
  expect("helper falls back to the default browser", helperText.includes('|| /usr/bin/open "$1"'), true);
  expect("helper passes zsh -n", (() => { try { execFileSync("/bin/zsh", ["-n", helper]); return true; } catch { return false; } })(), true);
  expect("ME: signing in after tap", signingIn(me), true);
  expect("EW: not signing in", signingIn(ew), false);
  expect("tap re-announces the account so every key redraws", heard.splice(0), [["me", false]]);
  expect("script passes zsh -n", (() => { try { execFileSync("/bin/zsh", ["-n", file]); return true; } catch { return false; } })(), true);
  expect("double tap: no second window", [await openSignIn(me), fake.opened.length], [true, 1]);
  fake.now += 16_000;
  expect("tap after 16s opens again", [await openSignIn(me), fake.opened.length], [true, 2]);
  const ewScript = signInScript(ew, "/x/it's claude", "/t/browser-ew");
  expect("EW: BROWSER helper", ewScript.includes("export BROWSER='/t/browser-ew'"), true);
  expect("no helper: no BROWSER line", signInScript(ew, "/x/claude").includes("BROWSER"), false);
  // "Default browser" on the key, or a custom profile in its box.
  fake.now += 16_000;
  fake.opened.length = 0;
  await openSignIn(ew, { openIn: "default" });
  const ewDefault = readFileSync(fake.opened[0]?.[0] ?? "/nonexistent", "utf8");
  expect("openIn default: no BROWSER helper", ewDefault.includes("BROWSER"), false);
  fake.now += 16_000;
  fake.opened.length = 0;
  await openSignIn(ew, { chromeProfile: "Profile 9" });
  const ewHelper = readFileSync(join(tmpdir(), "claude-usage-browser-ew"), "utf8");
  expect("custom profile box used", ewHelper.includes("'--profile-directory=Profile 9'"), true);
  heard.length = 0;
  expect("EW: own config dir", ewScript.includes("export CLAUDE_CONFIG_DIR=" + "'" + ew.configDir + "'"), true);
  expect("EW: email", ewScript.includes("--email 'eaglewatch9002@eaglewatch.ph'"), true);
  expect("quotes awkward paths", ewScript.includes("'/x/it'\\''s claude' auth login"), true);
  fake.opened.length = 0;
}

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
  expect("after sign-in: no sign-in needed", usage.signInNeeded?.(me), false);
  expect("after sign-in: no longer signing in", signInMod.signingIn?.(me), false);
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
