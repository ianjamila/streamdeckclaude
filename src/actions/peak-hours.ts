import streamDeck, {
  action,
  SingletonAction,
  type JsonObject,
  type KeyAction,
  type KeyDownEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import { peakState } from "../peak.js";
import { formatResetsIn, renderKey } from "../render.js";

// Pure clock maths, no network — tick often so the countdown and the
// PEAK/OFF flip land within a few seconds of the real boundary.
const REFRESH_MS = 20_000;
const PEAK_URL = "https://claude-peak-time.pages.dev/";

type Settings = JsonObject;

@action({ UUID: "com.aaronholt.claude-usage.peak-hours" })
export class PeakHoursAction extends SingletonAction<Settings> {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    if (!ev.action.isKey()) return;
    await this.tick(ev.action);
    const t = setInterval(() => {
      void this.tick(ev.action as KeyAction<Settings>);
    }, REFRESH_MS);
    this.timers.set(ev.action.id, t);
  }

  override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
    const t = this.timers.get(ev.action.id);
    if (t) clearInterval(t);
    this.timers.delete(ev.action.id);
  }

  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    if (ev.action.isKey()) void this.tick(ev.action);
    try {
      await streamDeck.system.openUrl(PEAK_URL);
    } catch (e) {
      streamDeck.logger.error(`openUrl failed: ${(e as Error).message}`);
    }
  }

  private async tick(action: KeyAction<Settings>): Promise<void> {
    const { peak, changesAt } = peakState();
    const countdown = formatResetsIn(new Date(changesAt).toISOString()) ?? "";
    await action.setImage(
      renderKey({
        big: peak ? "PEAK" : "OFF",
        label: "PEAK HRS",
        subtitle: peak ? `ends ${countdown}` : countdown,
        accent: peak,
      })
    );
  }
}
