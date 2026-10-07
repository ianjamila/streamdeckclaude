import streamDeck from "@elgato/streamdeck";
import { DEFAULT_ACCOUNT, type Account } from "./accounts.js";
import { notify } from "./notify.js";
import { chromeProfileArgs, type OpenSettings } from "./open-settings.js";
import { openCommandFile, openCommandLine, shellQuote, writeScript } from "./terminal.js";
import { findClaudeBinary, onUsageResult, reannounce, signInNeeded } from "./usage.js";

// Tapping a key whose account needs signing in (or clicking the banner that
// says so) opens Terminal on `claude auth login` for that account. Keys read
// "SIGNING IN" meanwhile; the sign-in watcher in usage.ts spots the new token
// and redraws them.

// A double tap shouldn't start two sign-ins.
const REOPEN_AFTER_MS = 15_000;
// How long keys read "SIGNING IN" if the new login never lands.
const SIGNING_IN_MS = 5 * 60_000;
const openedAt = new Map<string, number>();
// Accounts already told (by banner) that they need signing in, until their
// next good result, so a dead login gets one banner, not one per tick.
const bannered = new Set<string>();

onUsageResult((account, r) => {
  if (r.ok) {
    // A good result means the sign-in (if any) is over.
    openedAt.delete(account.id);
    bannered.delete(account.id);
  } else if (signInNeeded(account) && !bannered.has(account.id)) {
    bannered.add(account.id);
    void bannerSignIn(account);
  }
});

export function signingIn(account: Account): boolean {
  const at = openedAt.get(account.id);
  return at !== undefined && Date.now() - at < SIGNING_IN_MS;
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

// Writes the sign-in script (and its browser helper) and returns its path,
// or undefined if Claude Code isn't installed where we look.
// `settings` is the key's "Tap opens in" / "Chrome profile" choice.
async function prepareSignIn(account: Account, settings: OpenSettings): Promise<string | undefined> {
  const bin = await findClaudeBinary();
  if (!bin) {
    streamDeck.logger.warn(`sign-in[${account.id}]: Claude Code not found`);
    return undefined;
  }
  let browser: string | undefined;
  if (process.platform === "darwin" && settings.openIn !== "default") {
    const profile = settings.chromeProfile?.trim() || account.email;
    browser = await writeScript(
      `claude-usage-browser-${account.id}`,
      browserScript(account, await chromeProfileArgs(profile))
    );
  }
  return writeScript(`claude-usage-sign-in-${account.id}.command`, signInScript(account, bin, browser));
}

// Opens the sign-in window. Returns false if it couldn't (Claude Code not
// found, or opening failed) so the caller can fall back to the usage page.
export async function openSignIn(account: Account, settings: OpenSettings = {}): Promise<boolean> {
  const last = openedAt.get(account.id) ?? -Infinity;
  if (Date.now() - last < REOPEN_AFTER_MS) return true;
  try {
    const file = await prepareSignIn(account, settings);
    if (!file) return false;
    await openCommandFile(file);
  } catch (e) {
    streamDeck.logger.warn(`sign-in[${account.id}]: could not open Terminal: ${(e as Error).message}`);
    return false;
  }
  openedAt.set(account.id, Date.now());
  streamDeck.logger.info(`sign-in[${account.id}]: opened Terminal to sign in`);
  reannounce(account); // every key of the account now reads "SIGNING IN"
  return true;
}

// The banner when an account first needs signing in; clicking it opens the
// same sign-in window a tap would (with the account's own Chrome profile).
async function bannerSignIn(account: Account): Promise<void> {
  let file: string | undefined;
  try {
    file = await prepareSignIn(account, {});
  } catch {
    file = undefined; // still worth a banner without the click action
  }
  await notify({
    title: `Claude ${account.badge} needs signing in`,
    message: `${account.email}: tap its Stream Deck key to sign in.`,
    group: `claude-usage-sign-in-${account.id}`,
    onClick: file ? openCommandLine(file) : undefined,
    clickHint: "Or click here.",
  });
}
