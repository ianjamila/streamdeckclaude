import { execFile } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import streamDeck from "@elgato/streamdeck";
import { DEFAULT_ACCOUNT, type Account } from "./accounts.js";
import { chromeProfileArgs, type OpenSettings } from "./open-settings.js";
import { findClaudeBinary, onUsageResult, reannounce } from "./usage.js";

// Tapping a key whose account needs signing in opens Terminal on
// `claude auth login` for that account. Keys read "SIGNING IN" meanwhile;
// the sign-in watcher in usage.ts spots the new token and redraws them.

const execFileAsync = promisify(execFile);
// A double tap shouldn't start two sign-ins.
const REOPEN_AFTER_MS = 15_000;
// How long keys read "SIGNING IN" if the new login never lands.
const SIGNING_IN_MS = 5 * 60_000;
const openedAt = new Map<string, number>();

// A good result means the sign-in (if any) is over.
onUsageResult((account, r) => {
  if (r.ok) openedAt.delete(account.id);
});

export function signingIn(account: Account): boolean {
  const at = openedAt.get(account.id);
  return at !== undefined && Date.now() - at < SIGNING_IN_MS;
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

// `browser`: helper Claude Code runs (via BROWSER) to open the sign-in page;
// without it the page opens in the default browser.
export function signInScript(account: Account, bin: string, browser?: string): string {
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
    ...(browser ? [`export BROWSER=${shellQuote(browser)}`] : []),
    `${shellQuote(bin)} auth login --claudeai --email ${shellQuote(account.email)}`,
    "echo",
    `echo ${shellQuote("The Stream Deck keys update within about 20 seconds. You can close this window.")}`,
    "",
  ].join("\n");
}

// Claude Code runs $BROWSER with the page URL as its only argument. Open it
// in the account's Chrome profile, like a tap on a signed-in key does.
function browserScript(account: Account, openArgs: string[]): string {
  return [
    "#!/bin/zsh",
    `# Opens Claude sign-in pages in ${account.email}'s Chrome profile (Claude usage Stream Deck plugin).`,
    `/usr/bin/open ${openArgs.map(shellQuote).join(" ")} "$1" || /usr/bin/open "$1"`,
    "",
  ].join("\n");
}

async function writeScript(file: string, text: string): Promise<void> {
  await writeFile(file, text, "utf8");
  await chmod(file, 0o700);
}

// Opens the sign-in window. Returns false if it couldn't (Claude Code not
// found, or opening failed) so the caller can fall back to the usage page.
// `settings` is the key's "Tap opens in" / "Chrome profile" choice.
export async function openSignIn(account: Account, settings: OpenSettings = {}): Promise<boolean> {
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
    let browser: string | undefined;
    if (process.platform === "darwin" && settings.openIn !== "default") {
      browser = join(tmpdir(), `claude-usage-browser-${account.id}`);
      const profile = settings.chromeProfile?.trim() || account.email;
      await writeScript(browser, browserScript(account, await chromeProfileArgs(profile)));
    }
    await writeScript(file, signInScript(account, bin, browser));
    await execFileAsync("/usr/bin/open", [file]);
  } catch (e) {
    streamDeck.logger.warn(`sign-in[${account.id}]: could not open Terminal: ${(e as Error).message}`);
    return false;
  }
  openedAt.set(account.id, Date.now());
  streamDeck.logger.info(`sign-in[${account.id}]: opened Terminal to sign in`);
  reannounce(account); // every key of the account now reads "SIGNING IN"
  return true;
}
