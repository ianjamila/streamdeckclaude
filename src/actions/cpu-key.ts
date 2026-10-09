import streamDeck, {
  SingletonAction,
  type DidReceiveSettingsEvent,
  type JsonObject,
  type KeyAction,
  type KeyDownEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import { execFile } from "node:child_process";
import { renderLoading, SYSTEM_THEME } from "../render.js";
import { subscribe, type SystemSnapshot } from "../system.js";

type Key<S extends JsonObject> = {
  action: KeyAction<S>;
  settings: S;
  stop: () => void;
  last?: SystemSnapshot;
};

/** Activity Monitor on macOS, Task Manager on Windows. Shared with the Memory key. */
export function openActivityMonitor(): void {
  const [cmd, args] =
    process.platform === "win32" ? ["taskmgr", []] : ["open", ["-a", "Activity Monitor"]];
  execFile(cmd, args, (e) => {
    if (e) streamDeck.logger.error(`open activity monitor failed: ${e.message}`);
  });
}

// Shared base for the CPU keys: each visible key subscribes to the shared
// sampler and redraws on every snapshot. Tap opens Activity Monitor.
export abstract class CpuKeyAction<S extends JsonObject> extends SingletonAction<S> {
  protected abstract readonly label: string;
  protected abstract render(snap: SystemSnapshot, settings: S): string;

  private readonly keys = new Map<string, Key<S>>();

  override async onWillAppear(ev: WillAppearEvent<S>): Promise<void> {
    if (!ev.action.isKey()) return;
    const action = ev.action;
    await action.setImage(renderLoading(this.label, undefined, SYSTEM_THEME));
    const key: Key<S> = { action, settings: ev.payload.settings, stop: () => {} };
    this.keys.set(action.id, key);
    key.stop = subscribe((snap) => {
      key.last = snap;
      void this.draw(key.action, snap, key.settings);
    });
  }

  override onWillDisappear(ev: WillDisappearEvent<S>): void {
    this.keys.get(ev.action.id)?.stop();
    this.keys.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<S>): Promise<void> {
    const key = this.keys.get(ev.action.id);
    if (!key) return;
    key.settings = ev.payload.settings;
    if (key.last) await this.draw(key.action, key.last, key.settings);
  }

  override onKeyDown(_ev: KeyDownEvent<S>): void {
    openActivityMonitor();
  }

  private async draw(action: KeyAction<S>, snap: SystemSnapshot, settings: S): Promise<void> {
    try {
      await action.setImage(this.render(snap, settings));
    } catch (e) {
      streamDeck.logger.error(`${this.label}: ${(e as Error).message}`);
    }
  }
}
