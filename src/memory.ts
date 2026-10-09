import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

// One shared sampler for the Memory key. On macOS it reads `vm_stat` and
// `sysctl` (no root, no network) and works out "available" the way Activity
// Monitor does: total minus Memory Used, where Memory Used = App Memory +
// Wired + Compressed. Cached files don't count as used, because macOS drops
// them as soon as something needs the room. On other platforms it uses
// os.freemem(), which on Windows is already "available". The sampler runs only
// while a Memory key is on screen.

const execFileAsync = promisify(execFile);

export const MEMORY_SAMPLE_MS = 2_000;
// The graph keeps one point every HISTORY_EVERY samples: 30 points x 10s =
// the last 5 minutes (memory creeps up slowly, so a minute is too short).
const HISTORY = 30;
const HISTORY_EVERY = 5;

const GIB = 1024 ** 3;

// macOS memory pressure (kern.memorystatus_vm_pressure_level): 1 normal,
// 2 warning, 4 critical. This is what turns the Activity Monitor graph
// yellow / red.
export type Pressure = "normal" | "warn" | "critical";

export type MemorySnapshot = {
  totalBytes: number;
  // Total minus Memory Used (see top of file).
  availableBytes: number;
  usedBytes: number;
  // Undefined where the OS doesn't report it (Windows / Linux).
  swapUsedBytes?: number;
  compressedBytes?: number;
  pressure?: Pressure;
  // Used fraction 0..1, oldest first, one point per 10s.
  usedHistory: number[];
};

export type VmStat = {
  pageSize: number;
  // Raw page counts, keyed by vm_stat's own labels ("Pages free", ...).
  pages: Record<string, number>;
};

export function parseVmStat(text: string): VmStat | undefined {
  const size = /page size of (\d+) bytes/.exec(text);
  if (!size) return undefined;
  const pages: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const m = /^"?([^":]+)"?:\s+(\d+)\.?\s*$/.exec(line.trim());
    if (m) pages[m[1]!] = Number(m[2]);
  }
  return { pageSize: Number(size[1]), pages };
}

/** Activity Monitor's Memory Used: App Memory + Wired + Compressed, in bytes. */
export function usedFromVmStat(vm: VmStat): { used: number; compressed: number } | undefined {
  const p = vm.pages;
  const anon = p["Anonymous pages"];
  const wired = p["Pages wired down"];
  const compressor = p["Pages occupied by compressor"];
  if (anon === undefined || wired === undefined || compressor === undefined) return undefined;
  const app = Math.max(0, anon - (p["Pages purgeable"] ?? 0));
  return { used: (app + wired + compressor) * vm.pageSize, compressed: compressor * vm.pageSize };
}

/** "total = 6144.00M  used = 4715.62M  free = 1428.38M  (encrypted)" → used bytes. */
export function parseSwapUsage(text: string): number | undefined {
  const m = /used = ([\d.]+)([KMGT])/.exec(text);
  if (!m) return undefined;
  const unit = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2] as "K" | "M" | "G" | "T"];
  return Number(m[1]) * unit;
}

export function parsePressure(text: string): Pressure | undefined {
  const n = Number(text.trim());
  if (n === 1) return "normal";
  if (n === 2) return "warn";
  if (n === 4) return "critical";
  return undefined;
}

type Reading = Omit<MemorySnapshot, "usedHistory">;

async function readMac(): Promise<Reading> {
  const total = os.totalmem();
  const [vm, swap, pressure] = await Promise.all([
    execFileAsync("/usr/bin/vm_stat", [], { timeout: 5_000 }).then((r) => r.stdout),
    execFileAsync("/usr/sbin/sysctl", ["-n", "vm.swapusage"], { timeout: 5_000 })
      .then((r) => r.stdout)
      .catch(() => ""),
    execFileAsync("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { timeout: 5_000 })
      .then((r) => r.stdout)
      .catch(() => ""),
  ]);
  const parsed = parseVmStat(vm);
  const used = parsed && usedFromVmStat(parsed);
  if (!used) throw new Error("vm_stat: unexpected output");
  const usedBytes = Math.min(total, used.used);
  return {
    totalBytes: total,
    usedBytes,
    availableBytes: total - usedBytes,
    compressedBytes: used.compressed,
    swapUsedBytes: parseSwapUsage(swap),
    pressure: parsePressure(pressure),
  };
}

function readGeneric(): Reading {
  const total = os.totalmem();
  const free = Math.min(total, os.freemem());
  return { totalBytes: total, availableBytes: free, usedBytes: total - free };
}

async function read(): Promise<Reading> {
  if (process.platform !== "darwin") return readGeneric();
  try {
    return await readMac();
  } catch {
    // vm_stat missing or changed format: os.freemem() is low on macOS (free
    // pages only) but better than a blank key.
    return readGeneric();
  }
}

type Listener = (snap: MemorySnapshot) => void;

const listeners = new Set<Listener>();
let timer: NodeJS.Timeout | undefined;
let busy = false;
let samples = 0;
const usedHistory: number[] = [];
let last: MemorySnapshot | undefined;

async function tick(): Promise<void> {
  if (busy) return; // a slow vm_stat never stacks up readings
  busy = true;
  try {
    const r = await read();
    if (!timer) return; // unsubscribed while reading
    const usedFraction = r.totalBytes ? r.usedBytes / r.totalBytes : 0;
    if (samples++ % HISTORY_EVERY === 0) {
      usedHistory.push(usedFraction);
      if (usedHistory.length > HISTORY) usedHistory.shift();
    } else if (usedHistory.length) {
      // Between history steps the newest point holds the peak of its 10s window.
      usedHistory[usedHistory.length - 1] = Math.max(usedHistory[usedHistory.length - 1]!, usedFraction);
    }
    last = { ...r, usedHistory: [...usedHistory] };
    for (const fn of listeners) fn(last);
  } finally {
    busy = false;
  }
}

/** Start receiving snapshots every MEMORY_SAMPLE_MS. Returns an unsubscribe function. */
export function subscribeMemory(fn: Listener): () => void {
  listeners.add(fn);
  if (!timer) {
    timer = setInterval(() => void tick(), MEMORY_SAMPLE_MS);
    void tick();
  } else if (last) {
    fn(last);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size || !timer) return;
    clearInterval(timer);
    timer = undefined;
    samples = 0;
    last = undefined;
    usedHistory.length = 0;
  };
}

/** Bytes → "8.1G" (one decimal under 10 GB, whole numbers above). */
export function formatGiB(bytes: number): string {
  const g = bytes / GIB;
  if (g < 9.95) return `${g.toFixed(1)}G`;
  return `${Math.round(g)}G`;
}

export function toGiB(bytes: number): number {
  return bytes / GIB;
}

// ---- Low-memory banner -------------------------------------------------

/**
 * One banner per low-memory episode: fires when available drops below
 * `warnGiB`, re-arms only once it climbs back above warnGiB + REARM_GIB, so
 * hovering right at the line doesn't banner every few seconds.
 */
export const REARM_GIB = 1;

export function lowMemoryEdge(
  availableGiB: number,
  warnGiB: number,
  alreadyBannered: boolean
): { fire: boolean; bannered: boolean } {
  if (availableGiB < warnGiB) return { fire: !alreadyBannered, bannered: true };
  if (availableGiB >= warnGiB + REARM_GIB) return { fire: false, bannered: false };
  return { fire: false, bannered: alreadyBannered };
}

/**
 * Biggest memory users from `ps -axo rss=,comm=` output (RSS in KB, full
 * path). Helper processes are folded into their app ("Google Chrome Helper
 * (Renderer)" inside Google Chrome.app → "Google Chrome"), so a browser with
 * 40 tabs shows as one entry. RSS counts shared pages more than once, so these
 * are rough sizes for spotting the culprit, not exact figures.
 */
export function topMemoryApps(psOutput: string, limit = 3): { name: string; bytes: number }[] {
  const byApp = new Map<string, number>();
  for (const line of psOutput.split("\n")) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const cmd = m[2]!;
    const app = /\/([^/]+)\.app\//.exec(cmd)?.[1] ?? cmd.split("/").pop() ?? cmd;
    byApp.set(app, (byApp.get(app) ?? 0) + Number(m[1]) * 1024);
  }
  return [...byApp.entries()]
    .map(([name, bytes]) => ({ name, bytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, limit);
}

export async function readTopMemoryApps(limit = 3): Promise<{ name: string; bytes: number }[]> {
  if (process.platform === "win32") return [];
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-axo", "rss=,comm="], {
      timeout: 5_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return topMemoryApps(stdout, limit);
  } catch {
    return [];
  }
}
