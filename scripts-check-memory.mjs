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
expect("missing field", m.usedFromVmStat({ pageSize: 4096, pages: { "Pages free": 1 } }), undefined);

expect("swap M", m.parseSwapUsage("total = 6144.00M  used = 4715.62M  free = 1428.38M  (encrypted)"), 4715.62 * 1024 ** 2);
expect("swap G", m.parseSwapUsage("total = 8.00G  used = 1.50G  free = 6.50G"), 1.5 * G);
expect("swap none", m.parseSwapUsage(""), undefined);
expect("pressure 1", m.parsePressure("1\n"), "normal");
expect("pressure 2", m.parsePressure("2"), "warn");
expect("pressure 4", m.parsePressure("4"), "critical");
expect("pressure junk", m.parsePressure(""), undefined);

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
  totalBytes: 36 * G, availableBytes: availG * G, usedBytes: (36 - availG) * G, usedHistory: [], ...extra,
});
expect("level green", k.memoryLevel(snap(12), 7), "ok");
expect("level yellow", k.memoryLevel(snap(9.9), 7), "mid");
expect("level yellow edge", k.memoryLevel(snap(7), 7), "mid");
expect("level red", k.memoryLevel(snap(6.9), 7), "hot");
expect("pressure warn lifts green", k.memoryLevel(snap(20, { pressure: "warn" }), 7), "mid");
expect("pressure warn keeps red", k.memoryLevel(snap(5, { pressure: "warn" }), 7), "hot");
expect("pressure critical", k.memoryLevel(snap(20, { pressure: "critical" }), 7), "hot");
expect("custom line", k.memoryLevel(snap(9), 10), "hot");

expect("warn default", k.warnGiB({}), 7);
expect("warn junk", k.warnGiB({ warn: "x" }), 7);
expect("warn set", k.warnGiB({ warn: "10" }), 10);

expect("banner text", k.lowMemoryMessage(snap(6.8, { swapUsedBytes: 4.6 * G }), 7, [{ name: "Google Chrome", bytes: 6.1 * G }, { name: "node", bytes: 4.3 * G }]),
  "6.8 GB free of 36 GB (your line: 7 GB) · swap 4.6 GB. Biggest: Google Chrome 6.1 GB, node 4.3 GB.");
expect("banner text bare", k.lowMemoryMessage(snap(6.8), 7, []), "6.8 GB free of 36 GB (your line: 7 GB).");

// The rendered key carries the right number, label and subtitle.
const svg = (s, set) => Buffer.from(k.renderMemoryKey(s, set).split(",")[1], "base64").toString();
const has = (name, text, ...parts) => { for (const p of parts) if (!text.includes(p)) { fail++; console.log("FAIL", name, "missing", p); } };
has("free+swap", svg(snap(8.1, { swapUsedBytes: 4.6 * G }), {}), ">8.1GB<", ">RAM FREE<", ">of 36GB<", "#facc15");
has("free no swap", svg(snap(12, { swapUsedBytes: 0 }), {}), ">12GB<", ">of 36GB<", "#4ade80");
has("used pct", svg(snap(6, {}), { show: "used-pct" }), ">83%<", ">RAM USED<", ">6.0GB free<", "#ff6b6b");
has("used gb", svg(snap(6, {}), { show: "used-gb" }), ">30GB<", ">of 36GB<");

if (fail) { console.log(`${fail} check(s) failed`); process.exit(1); }
console.log("memory checks: all passed");
