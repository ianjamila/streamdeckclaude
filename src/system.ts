import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// One shared sampler for the CPU keys: CPU usage from os.cpus() tick deltas,
// temperature from the bin/cputemp helper (macOS SMC, no root). It runs only
// while at least one CPU key is on screen.

export const SAMPLE_MS = 2_000;
// 30 samples x 2s = the last minute, drawn as the key's sparkline.
const HISTORY = 30;
const HELPER_RETRY_MS = 15_000;

export type CpuTemp = { avg: number; max: number; sensors: number };

export type SystemSnapshot = {
  // 0–100, all cores, over the last SAMPLE_MS.
  usage: number;
  // 1-minute load average (always 0 on Windows).
  load: number;
  cores: number;
  temp?: CpuTemp;
  // Why temp is missing (short, fits under the number).
  tempError?: string;
  usageHistory: number[];
  // Average temp per sample, °C.
  tempHistory: number[];
};

type Listener = (snap: SystemSnapshot) => void;

const listeners = new Set<Listener>();
let timer: NodeJS.Timeout | undefined;
let prevTimes: { idle: number; total: number } | undefined;
const usageHistory: number[] = [];
const tempHistory: number[] = [];

let helper: ChildProcess | undefined;
let helperRetry: NodeJS.Timeout | undefined;
let latestTemp: CpuTemp | undefined;
let tempError: string | undefined = process.platform === "darwin" ? undefined : "macOS only";

function cpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

export function usageBetween(
  a: { idle: number; total: number },
  b: { idle: number; total: number }
): number {
  const total = b.total - a.total;
  if (total <= 0) return 0;
  const busy = total - (b.idle - a.idle);
  return Math.min(100, Math.max(0, (busy / total) * 100));
}

export function parseHelperLine(line: string): { temp?: CpuTemp; error?: string } {
  try {
    const j = JSON.parse(line) as { avg?: number; max?: number; n?: number; error?: string };
    if (typeof j.avg === "number" && typeof j.max === "number") {
      return { temp: { avg: j.avg, max: j.max, sensors: j.n ?? 0 } };
    }
    return { error: j.error ?? "bad reading" };
  } catch {
    return { error: "bad reading" };
  }
}

function helperPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "cputemp");
}

function startHelper(): void {
  if (process.platform !== "darwin" || helper) return;
  const child = spawn(helperPath(), ["--watch", String(SAMPLE_MS)], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  helper = child;
  let buf = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const r = parseHelperLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      latestTemp = r.temp;
      tempError = r.error;
    }
  });
  child.on("error", (e: NodeJS.ErrnoException) => {
    // Spawn failures may not be followed by "exit"; forget the dead child.
    if (helper === child) helper = undefined;
    tempError = e.code === "ENOENT" ? "no helper" : "sensor error";
  });
  child.on("exit", () => {
    if (helper !== child) return;
    helper = undefined;
    latestTemp = undefined;
    tempError ??= "sensor stopped";
    // Retry while keys still want data (e.g. the helper was killed).
    if (listeners.size && !helperRetry) {
      helperRetry = setTimeout(() => {
        helperRetry = undefined;
        if (listeners.size) startHelper();
      }, HELPER_RETRY_MS);
    }
  });
}

function stopHelper(): void {
  if (helperRetry) clearTimeout(helperRetry);
  helperRetry = undefined;
  const child = helper;
  helper = undefined;
  latestTemp = undefined;
  // Closing stdin makes the helper exit on its own; kill as a backstop.
  child?.stdin?.end();
  child?.kill();
}

function push(arr: number[], v: number): void {
  arr.push(v);
  if (arr.length > HISTORY) arr.shift();
}

let last: SystemSnapshot | undefined;

function tick(): void {
  const now = cpuTimes();
  const usage = prevTimes ? usageBetween(prevTimes, now) : 0;
  const first = !prevTimes;
  prevTimes = now;
  if (first) return; // need two readings for a delta

  push(usageHistory, usage);
  if (latestTemp) push(tempHistory, latestTemp.avg);

  last = {
    usage,
    load: os.loadavg()[0] ?? 0,
    cores: os.cpus().length,
    temp: latestTemp,
    tempError: latestTemp ? undefined : (tempError ?? "reading…"),
    usageHistory: [...usageHistory],
    tempHistory: [...tempHistory],
  };
  for (const fn of listeners) fn(last);
}

/** Start receiving snapshots every SAMPLE_MS. Returns an unsubscribe function. */
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  if (!timer) {
    startHelper();
    tick();
    timer = setInterval(tick, SAMPLE_MS);
  } else if (last) {
    fn(last);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size || !timer) return;
    clearInterval(timer);
    timer = undefined;
    prevTimes = undefined;
    last = undefined;
    usageHistory.length = 0;
    tempHistory.length = 0;
    stopHelper();
  };
}

export function toFahrenheit(c: number): number {
  return (c * 9) / 5 + 32;
}
