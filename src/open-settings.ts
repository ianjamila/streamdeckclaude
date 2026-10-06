import streamDeck from "@elgato/streamdeck";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ACCOUNT, type Account } from "./accounts.js";

export const SETTINGS_URL = "https://claude.ai/settings/usage";

// How a key opens its page, chosen in the key's Property Inspector
// (ui/account.html, ui/codex.html). A browser profile keeps one sign-in per
// site, so each account gets its own Chrome profile and the page opens
// already signed in to the right one.
export type OpenSettings = {
  openIn?: string; // "chrome" (default) | "default" (system default browser)
  chromeProfile?: string; // profile folder ("Profile 1") or email; blank = key's default
};

const CHROME_LOCAL_STATE = join(homedir(), "Library/Application Support/Google/Chrome/Local State");

// Chrome ignores --profile-email when it is already running, so an email is
// turned into its profile folder here: Local State lists each folder with the
// Google account signed in to it (profile.info_cache.<dir>.user_name). Only
// that map is read. Re-read on every tap so new profiles are picked up.
async function profileDirForEmail(email: string): Promise<string | undefined> {
  try {
    const state = JSON.parse(await readFile(CHROME_LOCAL_STATE, "utf8"));
    const cache: Record<string, { user_name?: string }> = state?.profile?.info_cache ?? {};
    const want = email.toLowerCase();
    return Object.keys(cache).find((dir) => cache[dir]?.user_name?.toLowerCase() === want);
  } catch {
    return undefined;
  }
}

// The profile is a folder name (the end of "Profile Path" on chrome://version,
// e.g. "Profile 1") or the email signed in to it. An email no profile is
// signed in to falls through to --profile-email, which a cold-started Chrome
// still honours; otherwise Chrome opens the last-used profile.
async function chromeArgs(url: string, profile: string): Promise<string[]> {
  const dir = profile.includes("@") ? await profileDirForEmail(profile) : profile;
  const flag = dir ? `--profile-directory=${dir}` : `--profile-email=${profile}`;
  return ["-na", "Google Chrome", "--args", flag, url];
}

function openInChrome(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("open", args, { timeout: 10_000 }, (err) => (err ? reject(err) : resolve()));
  });
}

// Opens `url` in the Chrome profile from settings (or `defaultProfile` when
// the box is blank); falls back to the default browser off macOS, when the
// key is set to "Default browser", or when Chrome can't be launched.
export async function openUrlInProfile(
  url: string,
  defaultProfile: string,
  settings: OpenSettings = {}
): Promise<void> {
  if (process.platform === "darwin" && settings.openIn !== "default") {
    try {
      await openInChrome(await chromeArgs(url, settings.chromeProfile?.trim() || defaultProfile));
      return;
    } catch (e) {
      streamDeck.logger.warn(`Chrome open failed, using default browser: ${(e as Error).message}`);
    }
  }
  try {
    await streamDeck.system.openUrl(url);
  } catch (e) {
    streamDeck.logger.error(`openUrl failed: ${(e as Error).message}`);
  }
}

export function openSettings(account: Account, settings: OpenSettings = {}): Promise<void> {
  return openUrlInProfile(SETTINGS_URL, account.email, settings);
}

// Codex (ChatGPT) is signed in to the ME profile.
export const CODEX_PROFILE = DEFAULT_ACCOUNT.email;
