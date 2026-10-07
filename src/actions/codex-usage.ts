import streamDeck, {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import {
  effectivePercent,
  findWindow,
  readCodexStatus,
  staleTag,
  windowLabel,
  type CodexStatus,
  type WindowKind,
} from "../codex.js";
import {
  CODEX_THEME,
  formatPercent,
  formatResetsIn,
  renderError,
  renderKey,
  renderLoading,
} from "../render.js";
import { CODEX_PROFILE, openUrlInProfile, type OpenSettings } from "../open-settings.js";
import { openCodexCheck, prepareCodexCheck } from "../codex-check.js";
import { notify } from "../notify.js";
import { openCommandLine } from "../terminal.js";

// Local file read only (no network), so it can refresh often.
const REFRESH_MS = 30_000;
const USAGE_URL = "https://chatgpt.com/settings/usage?tab=overview";
const LABEL = "CODEX";
// A double tap shouldn't open two check windows.
const REOPEN_AFTER_MS = 15_000;

// Chosen in the key's Property Inspector (ui/codex.html).
type Settings = OpenSettings & { window?: string };

function kindFrom(settings: Settings): WindowKind {
  return settings.window === "short" ? "short" : "weekly";
}

@action({ UUID: "com.aaronholt.claude-usage.codex" })
export class CodexUsageAction extends SingletonAction<Settings> {
  private readonly keys = new Map<string, { timer: NodeJS.Timeout; kind: WindowKind }>();
  // Codex usage stopped updating (status.attention): taps open the check
  // window instead of the usage page, and one banner goes out per episode.
  private attention = false;
  private bannered = false;
  private checkOpenedAt = -Infinity;

  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    if (!ev.action.isKey()) return;
    const action = ev.action;
    const timer = setInterval(() => void this.tick(action), REFRESH_MS);
    this.keys.set(action.id, { timer, kind: kindFrom(ev.payload.settings) });
    await action.setImage(renderLoading(LABEL, undefined, CODEX_THEME));
    await this.tick(action);
  }

  override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
    const key = this.keys.get(ev.action.id);
    if (key) clearInterval(key.timer);
    this.keys.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): Promise<void> {
    if (!ev.action.isKey()) return;
    const key = this.keys.get(ev.action.id);
    if (!key) return;
    key.kind = kindFrom(ev.payload.settings);
    await this.tick(ev.action);
  }

  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    if (ev.action.isKey()) void this.tick(ev.action);
    if (this.attention && (await this.openCheck())) return;
    await openUrlInProfile(USAGE_URL, CODEX_PROFILE, ev.payload.settings);
  }

  // False if it couldn't open (Codex not found), so the tap opens the usage
  // page instead.
  private async openCheck(): Promise<boolean> {
    if (Date.now() - this.checkOpenedAt < REOPEN_AFTER_MS) return true;
    try {
      if (!(await openCodexCheck())) return false;
    } catch (e) {
      streamDeck.logger.warn(`codex: could not open Terminal: ${(e as Error).message}`);
      return false;
    }
    this.checkOpenedAt = Date.now();
    return true;
  }

  private async banner(): Promise<void> {
    const file = await prepareCodexCheck().catch(() => undefined);
    await notify({
      title: "Codex usage stopped updating",
      message: "Codex replies aren't reporting usage: it may be signed out. Tap the Codex key to check.",
      group: "claude-usage-codex",
      onClick: file ? openCommandLine(file) : undefined,
      clickHint: "Or click here.",
    });
  }

  private async tick(action: KeyAction<Settings>): Promise<void> {
    const key = this.keys.get(action.id);
    if (!key) return;
    const status = await readCodexStatus().catch((e: Error): CodexStatus => {
      streamDeck.logger.error(`codex: ${e.message}`);
      return { ok: false, hint: "ERROR" };
    });
    this.attention = !status.ok && !!status.attention;
    if (status.ok) this.bannered = false;
    if (this.attention && !this.bannered) {
      this.bannered = true;
      streamDeck.logger.warn("codex: replies stopped reporting usage");
      void this.banner();
    }
    if (!status.ok) {
      await action.setImage(renderError(LABEL, undefined, CODEX_THEME, status.hint));
      return;
    }
    const { snap } = status;
    const w = findWindow(snap.limits, key.kind);
    if (!w) {
      await action.setImage(
        renderKey({
          big: "—",
          label: `${LABEL} ${key.kind === "short" ? "5H" : "7D"}`,
          subtitle: "not on plan",
          theme: CODEX_THEME,
        })
      );
      return;
    }
    const percent = effectivePercent(w);
    const reached = percent > 0 && !!snap.limits.rate_limit_reached_type;
    await action.setImage(
      renderKey({
        big: formatPercent(percent),
        label: `${LABEL} ${windowLabel(w)}`,
        subtitle: formatResetsIn(new Date(w.resets_at * 1000).toISOString()),
        accent: percent > 80 || reached,
        theme: CODEX_THEME,
        stale: staleTag(snap.at),
      })
    );
  }
}
