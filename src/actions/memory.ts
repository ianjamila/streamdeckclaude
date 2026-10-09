import streamDeck, {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import { MEMORY_THEME, renderLoading } from "../render.js";
import { lowMemoryEdge, readTopMemoryApps, subscribeMemory, toGiB, type MemorySnapshot } from "../memory.js";
import { lowMemoryMessage, renderMemoryKey, warnGiB, type MemorySettings } from "../memory-key.js";
import { notify } from "../notify.js";
import { openActivityMonitor } from "./cpu-key.js";

const LABEL = "MEMORY";

type Key = {
  action: KeyAction<MemorySettings>;
  settings: MemorySettings;
  stop: () => void;
  last?: MemorySnapshot;
};

// Banner state per warning line, so two Memory keys with the same line share
// one banner per low-memory episode.
const bannered = new Map<number, boolean>();

// Memory key: GB available (or used) every 2 seconds, with a 5-minute graph.
// Tap opens Activity Monitor.
@action({ UUID: "com.aaronholt.claude-usage.memory" })
export class MemoryAction extends SingletonAction<MemorySettings> {
  private readonly keys = new Map<string, Key>();

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
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<MemorySettings>): Promise<void> {
    const key = this.keys.get(ev.action.id);
    if (!key) return;
    key.settings = ev.payload.settings;
    if (key.last) await this.draw(key);
  }

  override onKeyDown(_ev: KeyDownEvent<MemorySettings>): void {
    openActivityMonitor();
  }

  private async draw(key: Key): Promise<void> {
    const snap = key.last;
    if (!snap) return;
    try {
      await key.action.setImage(renderMemoryKey(snap, key.settings));
    } catch (e) {
      streamDeck.logger.error(`${LABEL}: ${(e as Error).message}`);
    }
    if (key.settings.banner !== "off") void this.maybeBanner(snap, warnGiB(key.settings));
  }

  private async maybeBanner(snap: MemorySnapshot, warn: number): Promise<void> {
    const edge = lowMemoryEdge(toGiB(snap.availableBytes), warn, bannered.get(warn) ?? false);
    bannered.set(warn, edge.bannered);
    if (!edge.fire) return;
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
