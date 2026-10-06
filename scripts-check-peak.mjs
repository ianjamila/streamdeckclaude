import { isPeakAt, peakState } from "./src/peak.ts";
const iso = (ms) => new Date(ms).toISOString();
const cases = [
  ["2026-10-05T11:59:00Z", false], // Mon 04:59 PDT
  ["2026-10-05T12:00:00Z", true],  // Mon 05:00 PDT
  ["2026-10-05T17:59:00Z", true],  // Mon 10:59 PDT
  ["2026-10-05T18:00:00Z", false], // Mon 11:00 PDT
  ["2026-12-07T12:30:00Z", false], // Mon 04:30 PST
  ["2026-12-07T13:00:00Z", true],  // Mon 05:00 PST
  ["2026-12-07T19:00:00Z", false], // Mon 11:00 PST
  ["2026-10-10T15:00:00Z", false], // Sat
  ["2026-10-09T15:00:00Z", true],  // Fri 08:00 PDT
];
let fail = 0;
for (const [t, want] of cases) { const got = isPeakAt(Date.parse(t)); if (got !== want) { fail++; console.log("FAIL", t, got); } }
const chk = (t, peak, at) => { const s = peakState(Date.parse(t)); const ok = s.peak === peak && iso(s.changesAt) === at; if (!ok) { fail++; console.log("FAIL state", t, s.peak, iso(s.changesAt)); } };
chk("2026-10-05T14:20:00Z", true, "2026-10-05T18:00:00.000Z");
chk("2026-10-09T19:00:00Z", false, "2026-10-12T12:00:00.000Z"); // Fri after → Mon
chk("2026-10-31T10:00:00Z", false, "2026-11-02T13:00:00.000Z"); // weekend across DST end (Nov 1) → PST start
chk("2027-03-12T20:00:00Z", false, "2027-03-15T12:00:00.000Z"); // across DST start (Mar 14) → PDT start
console.log(fail ? `${fail} FAILED` : "all peak checks passed");
process.exit(fail ? 1 : 0);
