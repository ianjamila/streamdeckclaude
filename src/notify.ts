import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import streamDeck from "@elgato/streamdeck";
import { findBinary } from "./terminal.js";

// macOS banners for things that need the user even when the Stream Deck is
// out of view (a login that died, Codex usage that stopped updating). Same
// approach as Claude Code's notify hook (~/.claude/hooks/notify.mjs):
// terminal-notifier when installed, so a click can act; otherwise a plain
// osascript banner. Both follow the hook's switch, `cnotify on|quiet|off`:
// quiet and off mean no banners.

const execFileAsync = promisify(execFile);
const TERMINAL_NOTIFIER = ["/opt/homebrew/bin/terminal-notifier", "/usr/local/bin/terminal-notifier"];

function modeFile(): string {
  return process.env.CLAUDE_NOTIFY_MODE_FILE ?? join(homedir(), ".claude/notify-mode");
}

async function bannersAllowed(): Promise<boolean> {
  try {
    const mode = (await readFile(modeFile(), "utf8")).trim();
    return mode !== "quiet" && mode !== "off";
  } catch {
    return true; // no file = cnotify's default, "on"
  }
}

export type Banner = {
  title: string;
  message: string;
  // A newer banner with the same group replaces the older one.
  group: string;
  // Shell command run when the banner is clicked (terminal-notifier only),
  // and the words appended to the message when a click can run it.
  onClick?: string;
  clickHint?: string;
};

export async function notify(banner: Banner): Promise<void> {
  if (!(await bannersAllowed())) return;
  const tn = await findBinary(TERMINAL_NOTIFIER);
  if (tn) {
    const message = banner.onClick && banner.clickHint ? `${banner.message} ${banner.clickHint}` : banner.message;
    const args = ["-title", banner.title, "-message", message, "-sound", "Glass", "-group", banner.group];
    if (banner.onClick) args.push("-execute", banner.onClick);
    try {
      await execFileAsync(tn, args, { timeout: 10_000 });
      return;
    } catch {
      // Not allowed to notify (System Settings → Notifications) or broken:
      // fall through to a plain banner.
    }
  }
  const script = ["on run argv", 'display notification (item 1 of argv) with title (item 2 of argv) sound name "Glass"', "end run"];
  try {
    await execFileAsync("/usr/bin/osascript", [...script.flatMap((l) => ["-e", l]), banner.message, banner.title], {
      timeout: 10_000,
    });
  } catch (e) {
    streamDeck.logger.warn(`notify: banner failed: ${(e as Error).message}`);
  }
}
