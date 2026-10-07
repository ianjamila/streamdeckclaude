import { execFile } from "node:child_process";
import { access, chmod, constants, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// Small zsh scripts the plugin opens in the user's terminal (sign in to
// Claude Code, check the Codex login). A .command file opens in the user's
// terminal app via Launch Services, with no Automation permission prompt
// (unlike scripting Terminal).

const execFileAsync = promisify(execFile);

export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

// Writes an executable script to $TMPDIR/<name> and returns its path.
export async function writeScript(name: string, text: string): Promise<string> {
  const file = join(tmpdir(), name);
  await writeFile(file, text, "utf8");
  await chmod(file, 0o700);
  return file;
}

export async function openCommandFile(file: string): Promise<void> {
  await execFileAsync("/usr/bin/open", [file]);
}

// The shell command a notification click runs to open the same script.
export function openCommandLine(file: string): string {
  return `/usr/bin/open ${shellQuote(file)}`;
}

// First of `candidates` that exists and is executable.
export async function findBinary(candidates: readonly string[]): Promise<string | undefined> {
  for (const bin of candidates) {
    try {
      await access(bin, constants.X_OK);
      return bin;
    } catch {
      // not installed here
    }
  }
  return undefined;
}
