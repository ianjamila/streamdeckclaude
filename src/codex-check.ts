import { homedir } from "node:os";
import { join } from "node:path";
import { findBinary, openCommandFile, shellQuote, writeScript } from "./terminal.js";

// When Codex usage stops updating (see stalledTurns in codex.ts), a tap on
// the Codex key, or a click on its banner, opens Terminal on
// `codex login status`, offering `codex login` straight after.
// No Stream Deck imports, so scripts-check-codex.mjs can check it.

const CODEX_BINARIES = [
  join(homedir(), ".local/bin/codex"),
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
  join(homedir(), ".npm-global/bin/codex"),
];

export function codexCheckScript(bin: string): string {
  const codex = shellQuote(bin);
  return [
    "#!/bin/zsh",
    "# Written by the Claude usage Stream Deck plugin (src/codex-check.ts).",
    "clear",
    `echo ${shellQuote("Codex usage on the Stream Deck stopped updating: recent Codex replies never reported usage.")}`,
    `echo ${shellQuote("Checking the Codex sign-in:")}`,
    "echo",
    `${codex} login status`,
    "echo",
    `if read -q ${shellQuote("?Sign in to Codex again now? (y/n) ")}; then echo; ${codex} login; fi`,
    "echo",
    `echo ${shellQuote("The Stream Deck key updates after your next Codex reply. You can close this window.")}`,
    "",
  ].join("\n");
}

// Writes the check script and returns its path, or undefined if Codex isn't
// installed where we look.
export async function prepareCodexCheck(): Promise<string | undefined> {
  const bin = await findBinary(CODEX_BINARIES);
  return bin ? writeScript("claude-usage-codex-check.command", codexCheckScript(bin)) : undefined;
}

// Opens the check window; false if Codex wasn't found.
export async function openCodexCheck(): Promise<boolean> {
  const file = await prepareCodexCheck();
  if (!file) return false;
  await openCommandFile(file);
  return true;
}
