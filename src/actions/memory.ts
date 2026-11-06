import streamDeck, {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  type KeyUpEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import { MEMORY_THEME, renderLoading } from "../render.js";
import {
  alertAllowed,
  lowMemoryEdge,
  readTopMemoryApps,
  subscribeMemory,
  swapAlertEdge,
  toGiB,
  type MemorySnapshot,
} from "../memory.js";
import {
  heavySwapping,
  isPressureView,
  lowMemoryMessage,
  renderMemoryKey,
  swapAlertMessage,
  swapAlertTitle,
  swapLineGiB,
  warnGiB,
  type MemorySettings,
} from "../memory-key.js";
import { notify } from "../notify.js";
import { ACCESSIBILITY_PANE, openChromeTaskManager } from "../chrome-task-manager.js";
import { PressTimer } from "../long-press.js";
import { ACTIVITY_MONITOR_MEMORY_TAB, openActivityMonitor } from "./cpu-key.js";

const LABEL = "MEMORY";

type Key = {
  action: KeyAction<MemorySettings>;
  settings: MemorySettings;
  stop: () => void;
  last?: MemorySnapshot;
};

// Banner state per warning line, so two Memory keys with the same line share
// one banner per episode. Low free memory (free views) and high swap /
// critical pressure (pressure view) are tracked separately…
const bannered = new Map<number, boolean>();
const swapBannered = new Map<number, boolean>();
// …but share one cooldown, so a bad moment that trips both gives one banner.
let lastAlertAt: number | undefined;

// Memory key: GB available (or used, or macOS memory pressure + swap) every 2
// seconds, with a 5-minute graph. Tap opens Activity Monitor's Memory tab;
// hold (half a second) opens Chrome's Task Manager.
@action({ UUID: "com.aaronholt.claude-usage.memory" })
export class MemoryAction extends SingletonAction<MemorySettings> {
  private readonly keys = new Map<string, Key>();
  private readonly presses = new PressTimer();
  // One permission banner per plugin run; a failed hold still shows "!" on the key.
  private permissionBannered = false;

  override async onWillAppear(ev: WillAppearEvent<MemorySettings>): Promise<void> {
    if (!ev.action.isKey()) return;
    const act = ev.action;
    await act.setImage(renderLoading(LABEL, undefined, MEMORY_THEME));
    const key: Key = { action: act, settings: ev.payload.settings, stop: () => {} };
    this.keys.set(act.id, key);
    key.stop = subscribeMemory((snap) => {
      key.last = snap;
      void this.draw(key);
    });
  }

  override onWillDisappear(ev: WillDisappearEvent<MemorySettings>): void {
    this.keys.get(ev.action.id)?.stop();
    this.keys.delete(ev.action.id);
    this.presses.cancel(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<MemorySettings>): Promise<void> {
    const key = this.keys.get(ev.action.id);
    if (!key) return;
    key.settings = ev.payload.settings;
    if (key.last) await this.draw(key);
  }

  override onKeyDown(ev: KeyDownEvent<MemorySettings>): void {
    const act = ev.action;
    this.presses.down(act.id, () => void this.openChromeTaskManager(act));
  }

  override onKeyUp(ev: KeyUpEvent<MemorySettings>): void {
    if (this.presses.up(ev.action.id) === "tap") openActivityMonitor(ACTIVITY_MONITOR_MEMORY_TAB);
  }

  private async openChromeTaskManager(act: { showAlert(): Promise<void> }): Promise<void> {
    const r = await openChromeTaskManager();
    if (r.ok) return;
    streamDeck.logger.warn(`chrome task manager: ${r.reason}`);
    await act.showAlert().catch(() => {});
    if (!r.needsPermission || this.permissionBannered) return;
    this.permissionBannered = true;
    await notify({
      title: "Allow Stream Deck to open Chrome's Task Manager",
      message: "Holding the Memory key clicks Chrome's Window → Task Manager, which needs Stream Deck turned on under Privacy & Security → Accessibility.",
      group: "claude-usage-chrome-task-manager",
      onClick: `/usr/bin/open "${ACCESSIBILITY_PANE}"`,
      clickHint: "Click to open that setting.",
    });
  }

  private async draw(key: Key): Promise<void> {
    const snap = key.last;
    if (!snap) return;
    try {
      await key.action.setImage(renderMemoryKey(snap, key.settings));
    } catch (e) {
      streamDeck.logger.error(`${LABEL}: ${(e as Error).message}`);
    }
    if (key.settings.banner === "off") return;
    if (isPressureView(key.settings)) void this.maybeSwapBanner(snap, swapLineGiB(key.settings));
    else void this.maybeBanner(snap, warnGiB(key.settings));
  }

  /** Claims the shared cooldown; false (and a log line) if a banner went out recently. */
  private claimAlert(what: string): boolean {
    const now = Date.now();
    if (!alertAllowed(lastAlertAt, now)) {
      streamDeck.logger.info(`${what}: no banner, another memory banner went out < 10 min ago`);
      return false;
    }
    lastAlertAt = now;
    return true;
  }

  private async maybeSwapBanner(snap: MemorySnapshot, line: number): Promise<void> {
    const edge = swapAlertEdge(
      toGiB(snap.swapUsedBytes ?? 0),
      snap.pressure === "critical" || heavySwapping(snap),
      line,
      swapBannered.get(line) ?? false
    );
    swapBannered.set(line, edge.bannered);
    if (!edge.fire || !this.claimAlert("swap high")) return;
    const top = await readTopMemoryApps();
    const message = swapAlertMessage(snap, line, top);
    streamDeck.logger.info(`swap high: ${message}`);
    await notify({
      title: swapAlertTitle(snap, line),
      message,
      group: "claude-usage-memory-swap",
      onClick: process.platform === "darwin" ? `/usr/bin/open -a "Activity Monitor"` : undefined,
      clickHint: "Click to open Activity Monitor.",
    });
  }

  private async maybeBanner(snap: MemorySnapshot, warn: number): Promise<void> {
    const edge = lowMemoryEdge(toGiB(snap.availableBytes), warn, bannered.get(warn) ?? false);
    bannered.set(warn, edge.bannered);
    if (!edge.fire || !this.claimAlert("memory low")) return;
    const top = await readTopMemoryApps();
    const message = lowMemoryMessage(snap, warn, top);
    streamDeck.logger.info(`memory low: ${message}`);
    await notify({
      title: "Memory is running low",
      message,
      group: "claude-usage-memory-low",
      onClick: process.platform === "darwin" ? `/usr/bin/open -a "Activity Monitor"` : undefined,
      clickHint: "Click to open Activity Monitor.",
    });
  }
}
