import { ageTag } from "./age.js";

// What a Claude usage tile should draw, decided from the latest result and
// the account's last good numbers. Kept free of Stream Deck imports so
// scripts-check-stale.mjs can test it.

// Numbers older than this get an amber "20M OLD" tag (e.g. after the Mac
// wakes from sleep, or while the usage service is unreachable).
export const STALE_AFTER_MS = 15 * 60_000;

// Two-word reason shown under the "!" on an error key. Network and server
// problems are checked first: a refresh that fails that way isn't a sign-in
// problem.
export function errorHint(reason: string): string {
  if (reason.includes("network") || reason.includes("fetch failed")) return "OFFLINE";
  if (reason.includes("server error")) return "ERROR";
  if (reason.startsWith("token expired") || reason.includes("refresh")) return "SIGN-IN";
  if (reason === "rate_limited") return "RATE LIMIT";
  if (reason.startsWith("cannot read credentials")) return "NO LOGIN";
  return "ERROR";
}

// Failures the user must fix (sign in again, log in to Claude Code). Others
// (offline, rate limit, server error) are temporary: tiles keep showing the
// last good numbers, marked old.
export function needsAction(reason: string): boolean {
  const hint = errorHint(reason);
  return hint === "SIGN-IN" || hint === "NO LOGIN";
}

export type TileState<T> =
  | { kind: "error"; hint?: string }
  | { kind: "data"; data: T; stale?: string };

// `good` is the last good response and when it arrived. Its age always
// comes from that real success.
export function tileState<T>(
  r: { ok: true; data: T } | { ok: false; reason: string },
  good: { data: T; at: number } | undefined,
  now = Date.now()
): TileState<T> {
  if (!r.ok && needsAction(r.reason)) return { kind: "error", hint: errorHint(r.reason) };
  const latest = good ?? (r.ok ? { data: r.data, at: now } : undefined);
  if (!latest) return { kind: "error", hint: r.ok ? undefined : errorHint(r.reason) };
  const age = now - latest.at;
  return { kind: "data", data: latest.data, stale: age > STALE_AFTER_MS ? ageTag(age) : undefined };
}
