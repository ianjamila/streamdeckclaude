import { execFile } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import streamDeck from "@elgato/streamdeck";
import { DEFAULT_ACCOUNT, type Account } from "./accounts.js";
import { findClaudeBinary } from "./usage.js";

// Tapping a key whose account needs signing in opens Terminal on
// `claude auth login` for that account. The sign-in watcher in usage.ts then
// spots the new token and redraws every key, so nothing else is needed here.

const execFileAsync = promisify(execFile);
// A double tap shouldn't start two sign-ins.
const REOPEN_AFTER_MS = 15_000;
const openedAt = new Map<string, number>();

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

export function signInScript(account: Account, bin: string): string {
  // The default login must run without CLAUDE_CONFIG_DIR: setting it, even
  // to ~/.claude, makes Claude Code use a different Keychain item.
  const configDir =
    account === DEFAULT_ACCOUNT
      ? "unset CLAUDE_CONFIG_DIR"
      : `export CLAUDE_CONFIG_DIR=${shellQuote(account.configDir)}`;
  return [
    "#!/bin/zsh",
    "# Written by the Claude usage Stream Deck plugin (src/sign-in.ts).",
    "clear",
    `echo ${shellQuote(`Sign in to Claude Code (${account.badge}) as ${account.email}`)}`,
    `echo ${shellQuote("A browser page opens: sign in with that account there.")}`,
    "echo",
    configDir,
    `${shellQuote(bin)} auth login --claudeai --email ${shellQuote(account.email)}`,
    "echo",
    `echo ${shellQuote("The Stream Deck keys update within about 20 seconds. You can close this window.")}`,
    "",
  ].join("\n");
}

// Opens the sign-in window. Returns false if it couldn't (Claude Code not
// found, or opening failed) so the caller can fall back to the usage page.
export async function openSignIn(account: Account): Promise<boolean> {
  const last = openedAt.get(account.id) ?? -Infinity;
  if (Date.now() - last < REOPEN_AFTER_MS) return true;
  const bin = await findClaudeBinary();
  if (!bin) {
    streamDeck.logger.warn(`sign-in[${account.id}]: Claude Code not found`);
    return false;
  }
  // A .command file opens in the user's terminal app via Launch Services,
  // with no Automation permission prompt (unlike scripting Terminal).
  const file = join(tmpdir(), `claude-usage-sign-in-${account.id}.command`);
  try {
    await writeFile(file, signInScript(account, bin), "utf8");
    await chmod(file, 0o700);
    await execFileAsync("/usr/bin/open", [file]);
  } catch (e) {
    streamDeck.logger.warn(`sign-in[${account.id}]: could not open Terminal: ${(e as Error).message}`);
    return false;
  }
  openedAt.set(account.id, Date.now());
  streamDeck.logger.info(`sign-in[${account.id}]: opened Terminal to sign in`);
  return true;
}
