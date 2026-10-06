import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// Each Claude Code login lives in its own config dir (CLAUDE_CONFIG_DIR).
// The default dir uses the plain Keychain service name; any other dir gets
// "-<first 8 hex of sha256(dir)>" appended — the same rule Claude Code uses.
// Keep the ids/labels in sync with the dropdown in ui/account.html.
export type Account = {
  id: string;
  badge: string;
  configDir: string;
  // The account's sign-in email; also the default Chrome profile a tap opens.
  email: string;
};

const DEFAULT_CONFIG_DIR = join(homedir(), ".claude");

export const ACCOUNTS: readonly Account[] = [
  { id: "me", badge: "ME", configDir: DEFAULT_CONFIG_DIR, email: "jamilaian21@gmail.com" },
  {
    id: "ew",
    badge: "EWI",
    configDir: join(homedir(), ".claude-eaglewatch"),
    email: "eaglewatch9002@eaglewatch.ph",
  },
];

export const DEFAULT_ACCOUNT = ACCOUNTS[0];

export function accountById(id: unknown): Account {
  return ACCOUNTS.find((a) => a.id === id) ?? DEFAULT_ACCOUNT;
}

export function keychainService(account: Account): string {
  if (account.configDir === DEFAULT_CONFIG_DIR) return "Claude Code-credentials";
  const suffix = createHash("sha256").update(account.configDir).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${suffix}`;
}

export function credentialsFile(account: Account): string {
  return join(account.configDir, ".credentials.json");
}
