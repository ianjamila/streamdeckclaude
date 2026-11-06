// Checks src/memory.ts + src/memory-key.ts: `node scripts-check-memory.mjs`.
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

const m = await import("./src/memory.ts");
const k = await import("./src/memory-key.ts");
let fail = 0;
const expect = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) { fail++; console.log("FAIL", name, "got", JSON.stringify(got), "want", JSON.stringify(want)); } };
const G = 1024 ** 3;

// Real vm_stat output from this Mac (36 GB M4 Max), 2026-10-09.
const VM = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                5842.
Pages active:                            834338.
Pages inactive:                          825046.
Pages speculative:                         7612.
Pages throttled:                              0.
Pages wired down:                        293095.
Pages purgeable:                          30894.
"Translation faults":                2928110867.
File-backed pages:                       435242.
Anonymous pages:                        1231754.
Pages stored in compressor:             1159419.
Pages occupied by compressor:            334489.
`;
const vm = m.parseVmStat(VM);
expect("page size", vm.pageSize, 16384);
expect("quoted label", vm.pages["Translation faults"], 2928110867);
const used = m.usedFromVmStat(vm);
// App (anon - purgeable) + wired + compressor = 1200860 + 293095 + 334489 pages.
expect("used bytes", used.used, (1200860 + 293095 + 334489) * 16384);
expect("compressed", used.compressed, 334489 * 16384);
expect("used ~27.9GB", m.formatGiB(used.used), "28GB");
expect("not vm_stat", m.parseVmStat("garbage"), undefined);
expect("swapouts bytes", m.swapOutBytesFromVmStat(m.parseVmStat(VM + "Swapouts:                             157741526.\n")), 157741526 * 16384);
expect("swapouts missing", m.swapOutBytesFromVmStat(vm), undefined);
expect("rate none", m.rateFromSamples([[0, 5]]), undefined);
expect("rate 1MB/s", m.rateFromSamples([[0, 0], [1000, 1], [20000, 20 * 1024 ** 2]]), 1024 ** 2);
expect("rate reset", m.rateFromSamples([[0, 500], [2000, 100]]), 0);
expect("rate same time", m.rateFromSamples([[5, 0], [5, 9]]), undefined);
expect("missing field", m.usedFromVmStat({ pageSize: 4096, pages: { "Pages free": 1 } }), undefined);

expect("swap M", m.parseSwapUsage("total = 6144.00M  used = 4715.62M  free = 1428.38M  (encrypted)"), 4715.62 * 1024 ** 2);
expect("swap G", m.parseSwapUsage("total = 8.00G  used = 1.50G  free = 6.50G"), 1.5 * G);
expect("swap none", m.parseSwapUsage(""), undefined);
expect("pressure 1", m.parsePressure("1\n"), "normal");
expect("pressure 2", m.parsePressure("2"), "warn");
expect("pressure 4", m.parsePressure("4"), "critical");
expect("pressure junk", m.parsePressure(""), undefined);
expect("swap total M", m.parseSwapTotal("total = 8192.00M  used = 6875.75M  free = 1316.25M  (encrypted)"), 8192 * 1024 ** 2);
expect("swap total none", m.parseSwapTotal(""), undefined);
expect("pressure % 55 free", m.parsePressurePercent("55\n"), 45);
expect("pressure % 0 free", m.parsePressurePercent("0"), 100);
expect("pressure % 100 free", m.parsePressurePercent("100"), 0);
expect("pressure % junk", m.parsePressurePercent("x"), undefined);
expect("pressure % empty", m.parsePressurePercent(""), undefined);
expect("pressure % >100", m.parsePressurePercent("140"), undefined);

// History: a new point every 10s, the newest holds its window's peak, capped.
{
  const h = [];
  m.pushPeak(h, 0.2, true); m.pushPeak(h, 0.5, false); m.pushPeak(h, 0.3, false);
  expect("peak held", h, [0.5]);
  m.pushPeak(h, 0.1, true);
  expect("new point", h, [0.5, 0.1]);
  m.pushPeak(h, 0.9, true, 2);
  expect("capped", h, [0.1, 0.9]);
  const e = []; m.pushPeak(e, 0.4, false);
  expect("first sample always lands", e, [0.4]);
}

// Swap / critical alert: one per episode, re-arms 1 GB under the line.
expect("swap edge below", m.swapAlertEdge(5, false, 10, false), { fire: false, bannered: false });
expect("swap edge hit", m.swapAlertEdge(10, false, 10, false), { fire: true, bannered: true });
expect("swap edge still", m.swapAlertEdge(12, false, 10, true), { fire: false, bannered: true });
expect("swap edge hover", m.swapAlertEdge(9.5, false, 10, true), { fire: false, bannered: true });
expect("swap edge rearm", m.swapAlertEdge(8.9, false, 10, true), { fire: false, bannered: false });
expect("critical fires", m.swapAlertEdge(2, true, 10, false), { fire: true, bannered: true });
expect("critical holds", m.swapAlertEdge(2, true, 10, true), { fire: false, bannered: true });

// Shared cooldown between low-memory and swap banners.
expect("alert first", m.alertAllowed(undefined, 1000), true);
expect("alert too soon", m.alertAllowed(1000, 1000 + m.ALERT_COOLDOWN_MS - 1), false);
expect("alert after", m.alertAllowed(1000, 1000 + m.ALERT_COOLDOWN_MS), true);

expect("fmt 8.1", m.formatGiB(8.1 * G), "8.1GB");
expect("fmt 0.4", m.formatGiB(0.4 * G), "0.4GB");
expect("fmt 9.96 → 10", m.formatGiB(9.96 * G), "10GB");
expect("fmt 36", m.formatGiB(36 * G), "36GB");

// Banner fires once per episode, re-arms only 1 GB above the line.
expect("edge above", m.lowMemoryEdge(9, 7, false), { fire: false, bannered: false });
expect("edge drop", m.lowMemoryEdge(6.9, 7, false), { fire: true, bannered: true });
expect("edge still low", m.lowMemoryEdge(5, 7, true), { fire: false, bannered: true });
expect("edge hover", m.lowMemoryEdge(7.5, 7, true), { fire: false, bannered: true });
expect("edge rearm", m.lowMemoryEdge(8, 7, true), { fire: false, bannered: false });

const PS = `  512000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
 1024000 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)
  800000 /opt/homebrew/bin/node
  700000 /opt/homebrew/bin/node
   10000 /usr/sbin/cfprefsd
garbage line`;
expect("top apps", m.topMemoryApps(PS, 2).map((t) => [t.name, t.bytes]), [
  ["Google Chrome", 1536000 * 1024],
  ["node", 1500000 * 1024],
]);

const snap = (availG, extra = {}) => ({
  totalBytes: 36 * G, availableBytes: availG * G, usedBytes: (36 - availG) * G, usedHistory: [], pressureHistory: [], ...extra,
});
expect("level green", k.memoryLevel(snap(12), 7), "ok");
expect("level yellow", k.memoryLevel(snap(9.9), 7), "mid");
expect("level yellow edge", k.memoryLevel(snap(7), 7), "mid");
expect("level red", k.memoryLevel(snap(6.9), 7), "hot");
// Free views colour by GB only; pressure has its own view now.
expect("pressure warn ignored", k.memoryLevel(snap(20, { pressure: "warn" }), 7), "ok");
expect("pressure critical ignored", k.memoryLevel(snap(20, { pressure: "critical" }), 7), "ok");
expect("pressure warn keeps red", k.memoryLevel(snap(5, { pressure: "warn" }), 7), "hot");
expect("plevel normal", k.pressureLevel("normal"), "ok");
expect("plevel unknown", k.pressureLevel(undefined), "ok");
expect("plevel warn", k.pressureLevel("warn"), "mid");
expect("plevel critical", k.pressureLevel("critical"), "hot");
expect("swap lvl none", k.swapLevel(undefined, 10), "ok");
expect("swap lvl green", k.swapLevel(6.9 * G, 10), "ok");
expect("swap lvl yellow", k.swapLevel(7 * G, 10), "mid");
expect("swap lvl red", k.swapLevel(10 * G, 10), "hot");
expect("swap line default", k.swapLineGiB({}), 10);
expect("swap line junk", k.swapLineGiB({ swap: "-3" }), 10);
expect("swap line set", k.swapLineGiB({ swap: "6" }), 6);
expect("swap tag off", k.swapTag(snap(8, { swapUsedBytes: 9.9 * G }), 10), undefined);
expect("swap tag on", k.swapTag(snap(8, { swapUsedBytes: 11 * G }), 10), "SWAP 11GB");
expect("swap tag none", k.swapTag(snap(8), 10), undefined);
const MB = 1024 ** 2;
expect("swapping none", k.swappingLevel(undefined), "ok");
expect("swapping low", k.swappingLevel(4.9 * MB), "ok");
expect("swapping mid", k.swappingLevel(5 * MB), "mid");
expect("swapping hot", k.swappingLevel(50 * MB), "hot");
expect("worse", [k.worse("ok", "mid"), k.worse("hot", "mid"), k.worse("ok", "ok")], ["mid", "hot", "ok"]);
expect("tag swapping beats size", k.swapTag(snap(8, { swapUsedBytes: 11 * G, swapOutBytesPerSec: 60 * MB }), 10), "SWAPPING");
expect("tag mid swapping no tag", k.swapTag(snap(8, { swapUsedBytes: 2 * G, swapOutBytesPerSec: 10 * MB }), 10), undefined);
expect("heavy", [k.heavySwapping(snap(8, { swapOutBytesPerSec: 50 * MB })), k.heavySwapping(snap(8, { swapOutBytesPerSec: 49 * MB })), k.heavySwapping(snap(8))], [true, false, false]);
expect("title heavy", k.swapAlertTitle(snap(8, { swapUsedBytes: 2 * G, swapOutBytesPerSec: 80 * MB }), 10), "Mac is swapping heavily");
expect("title high wins", k.swapAlertTitle(snap(8, { swapUsedBytes: 11 * G, swapOutBytesPerSec: 80 * MB }), 10), "Swap is high");
expect("msg heavy", k.swapAlertMessage(snap(8, { swapUsedBytes: 2 * G, swapOutBytesPerSec: 80 * MB }), 10, []), "Swap 2.0 GB (your line: 10 GB) · writing 80 MB/s to swap · 8.0 GB free of 36 GB.");
expect("custom line", k.memoryLevel(snap(9), 10), "hot");

expect("warn default", k.warnGiB({}), 5);
expect("warn junk", k.warnGiB({ warn: "x" }), 5);
expect("warn set", k.warnGiB({ warn: "10" }), 10);

expect("banner text", k.lowMemoryMessage(snap(6.8, { swapUsedBytes: 4.6 * G }), 7, [{ name: "Google Chrome", bytes: 6.1 * G }, { name: "node", bytes: 4.3 * G }]),
  "6.8 GB free of 36 GB (your line: 7 GB) · swap 4.6 GB. Biggest: Google Chrome 6.1 GB, node 4.3 GB.");
expect("banner text bare", k.lowMemoryMessage(snap(6.8), 7, []), "6.8 GB free of 36 GB (your line: 7 GB).");
expect("swap banner text", k.swapAlertMessage(snap(4.1, { swapUsedBytes: 11 * G, pressurePercent: 62, pressure: "critical" }), 10, [{ name: "node", bytes: 4.3 * G }]),
  "Swap 11 GB (your line: 10 GB) · pressure 62% (critical) · 4.1 GB free of 36 GB. Biggest: node 4.3 GB.");
expect("swap banner bare", k.swapAlertMessage(snap(9), 10, []), "9.0 GB free of 36 GB.");
expect("swap title high", k.swapAlertTitle(snap(9, { swapUsedBytes: 11 * G, pressure: "normal" }), 10), "Swap is high");
expect("swap title critical", k.swapAlertTitle(snap(9, { swapUsedBytes: 2 * G, pressure: "critical" }), 10), "Memory pressure critical");
expect("swap title both", k.swapAlertTitle(snap(9, { swapUsedBytes: 11 * G, pressure: "critical" }), 10), "Memory pressure critical, swap high");

// The rendered key carries the right number, label and subtitle.
const svg = (s, set) => Buffer.from(k.renderMemoryKey(s, set).split(",")[1], "base64").toString();
const has = (name, text, ...parts) => { for (const p of parts) if (!text.includes(p)) { fail++; console.log("FAIL", name, "missing", p); } };
has("free+swap", svg(snap(8.1, { swapUsedBytes: 4.6 * G }), { warn: "7" }), ">8.1GB<", ">RAM FREE<", ">of 36GB<", "#facc15");
has("free no swap", svg(snap(12, { swapUsedBytes: 0 }), {}), ">12GB<", ">of 36GB<", "#4ade80");
has("used pct", svg(snap(6, {}), { show: "used-pct", warn: "7" }), ">83%<", ">RAM USED<", ">6.0GB free<", "#ff6b6b");
has("used gb", svg(snap(6, {}), { show: "used-gb" }), ">30GB<", ">of 36GB<");
// Default line is 5 GB: 6.5 GB free is yellow (5..8), 4.9 GB red, 8 GB green.
has("default line yellow", svg(snap(6.5), {}), "#facc15");
has("default line red", svg(snap(4.9), {}), "#ff6b6b");
has("default line green", svg(snap(8), {}), "#4ade80");
const lacks = (name, text, ...parts) => { for (const p of parts) if (text.includes(p)) { fail++; console.log("FAIL", name, "unexpected", p); } };
// Free view: green despite critical pressure; swap tag only past the line.
{
  const t = svg(snap(20, { pressure: "critical", swapUsedBytes: 11 * G }), {});
  has("free ignores pressure + tag", t, "#4ade80", ">SWAP 11GB<");
  lacks("free ignores pressure", t, "#ff6b6b");
  lacks("no tag under line", svg(snap(20, { swapUsedBytes: 6 * G }), {}), "SWAP");
  has("tag on used view", svg(snap(20, { swapUsedBytes: 12 * G }), { show: "used-pct" }), ">SWAP 12GB<");
  has("tag follows setting", svg(snap(20, { swapUsedBytes: 6.5 * G }), { swap: "6" }), ">SWAP 6.5GB<");
}
// Free view graph is the free share (falls as free falls); used views graph used.
{
  const hist = { usedHistory: [0.25, 0.75] };
  // sparkSvg maps value v to y = 114 - v*80: free 0.75 → 54.0, 0.25 → 94.0.
  has("free graph", svg(snap(9, hist), {}), "0.0,54.0 144.0,94.0");
  has("used graph", svg(snap(9, hist), { show: "used-gb" }), "0.0,94.0 144.0,54.0");
}
// Pressure view.
{
  const p = (extra, set = {}) => svg(snap(9, extra), { show: "pressure", ...set });
  const t = p({ pressurePercent: 45, pressure: "normal", swapUsedBytes: 6.7 * G, pressureHistory: [0.4, 0.5] });
  has("pressure view", t, ">45%<", ">PRESSURE<", ">swap 6.7GB<", "#4ade80", "0.0,82.0 144.0,74.0");
  lacks("pressure view no tag", t, "SWAP", "RAM FREE");
  has("pressure warn yellow", p({ pressurePercent: 70, pressure: "warn", swapUsedBytes: 1 * G }), ">70%<", "#facc15");
  has("pressure critical red", p({ pressurePercent: 90, pressure: "critical", swapUsedBytes: 1 * G }), "#ff6b6b");
  // Swap line coloured on its own: yellow 3 GB under the line, red at it.
  has("swap yellow", p({ pressurePercent: 45, pressure: "normal", swapUsedBytes: 8 * G }), 'fill="#facc15" opacity="1">swap 8.0GB<');
  has("swap red", p({ pressurePercent: 45, pressure: "normal", swapUsedBytes: 10 * G }), 'fill="#ff6b6b" opacity="1">swap 10GB<');
  has("swap red custom line", p({ pressurePercent: 45, pressure: "normal", swapUsedBytes: 6 * G }, { swap: "6" }), 'fill="#ff6b6b" opacity="1">swap 6.0GB<');
  has("swap white", p({ pressurePercent: 45, pressure: "normal", swapUsedBytes: 2 * G }), 'opacity="0.9">swap 2.0GB<');
  has("pressure unknown", p({}), ">—<", ">no swap info<");
  // Swapping now: arrow + yellow at 5 MB/s, red at 50 MB/s, even with small swap.
  const MB = 1024 ** 2;
  has("swapping arrow", p({ pressurePercent: 45, pressure: "normal", swapUsedBytes: 2 * G, swapOutBytesPerSec: 6 * MB }), 'fill="#facc15" opacity="1">swap 2.0GB ↑<');
  has("swapping heavy", p({ pressurePercent: 45, pressure: "normal", swapUsedBytes: 2 * G, swapOutBytesPerSec: 60 * MB }), 'fill="#ff6b6b" opacity="1">swap 2.0GB ↑<');
  has("idle no arrow", p({ pressurePercent: 45, pressure: "normal", swapUsedBytes: 2 * G, swapOutBytesPerSec: 0 }), 'opacity="0.9">swap 2.0GB<');
  has("free view swapping tag", svg(snap(20, { swapOutBytesPerSec: 60 * MB }), {}), ">SWAPPING<");
}

// Tap vs hold (src/long-press.ts), with a 40 ms hold so it runs fast.
{
  const lp = await import("./src/long-press.ts");
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const t = new lp.PressTimer(40);
  let holds = 0;
  t.down("a", () => holds++);
  await wait(10);
  expect("quick release = tap", [t.up("a"), holds], ["tap", 0]);
  await wait(60);
  expect("tap never fires hold later", holds, 0);
  t.down("a", () => holds++);
  await wait(70);
  expect("hold fires while held", holds, 1);
  expect("release after hold", t.up("a"), "hold");
  expect("up without down", t.up("a"), "none");
  t.down("b", () => holds++);
  t.cancel("b");
  await wait(70);
  expect("cancelled press never fires", [holds, t.up("b")], [1, "none"]);
  t.down("c", () => holds++); t.down("d", () => holds++);
  await wait(10);
  expect("keys independent", [t.up("c"), holds], ["tap", 1]);
  await wait(60);
  expect("other key still holds", [holds, t.up("d")], [2, "hold"]);
  // A second down on the same key (missed key-up) restarts the press: one hold, not two.
  let twice = 0;
  t.down("e", () => twice++); await wait(20); t.down("e", () => twice++);
  await wait(70);
  expect("re-press fires once", [twice, t.up("e")], [1, "hold"]);
  expect("default hold", lp.HOLD_MS, 500);
}
{
  const c = await import("./src/chrome-task-manager.ts");
  expect("perm assistive", c.isPermissionError("execution error: osascript is not allowed assistive access. (-25211)"), true);
  expect("perm automation", c.isPermissionError("Not authorized to send Apple events to System Events. (-1743)"), true);
  expect("perm other", c.isPermissionError("Chrome's Window menu has no Task Manager item"), false);
  has("script clicks the menu item", c.CHROME_TASK_MANAGER_SCRIPT, 'menu item "Task Manager" of menu "Window" of menu bar 1', 'activate');
}

if (fail) { console.log(`${fail} check(s) failed`); process.exit(1); }
console.log("memory checks: all passed");
