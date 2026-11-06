import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Opens Chrome's own Task Manager (memory per tab and extension) by clicking
// Window → Task Manager. Chrome has no URL or command-line switch for it, so
// this goes through System Events, which needs Stream Deck allowed under
// System Settings → Privacy & Security → Accessibility (macOS asks once for
// "control System Events" too). Clicking the menu item works whatever
// keyboard shortcut the item has.

const execFileAsync = promisify(execFile);

export const CHROME_TASK_MANAGER_SCRIPT = `
tell application "Google Chrome" to activate
tell application "System Events"
  repeat 25 times
    if exists (process "Google Chrome") then
      tell process "Google Chrome"
        if exists (menu item "Task Manager" of menu "Window" of menu bar 1) then
          click menu item "Task Manager" of menu "Window" of menu bar 1
          return "ok"
        end if
      end tell
    end if
    delay 0.2
  end repeat
end tell
error "Chrome's Window menu has no Task Manager item"
`;

export const ACCESSIBILITY_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

export type ChromeTaskManagerResult = { ok: true } | { ok: false; reason: string; needsPermission: boolean };

/**
 * "not allowed assistive access" / -25211 / -1719 = Accessibility not granted;
 * -1743 = Automation ("control System Events") refused.
 */
export function isPermissionError(message: string): boolean {
  return /assistive access|not allowed|not authori[sz]ed|-25211|-1719|-1743/i.test(message);
}

export async function openChromeTaskManager(): Promise<ChromeTaskManagerResult> {
  if (process.platform !== "darwin") return { ok: false, reason: "macOS only", needsPermission: false };
  try {
    await execFileAsync("/usr/bin/osascript", ["-e", CHROME_TASK_MANAGER_SCRIPT], { timeout: 15_000 });
    return { ok: true };
  } catch (e) {
    const err = e as Error & { stderr?: string };
    const reason = (err.stderr || err.message || "").trim();
    return { ok: false, reason, needsPermission: isPermissionError(reason) };
  }
}
