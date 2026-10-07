import {
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import { accountById, type Account } from "../accounts.js";
import {
  getUsage,
  invalidateUsageCache,
  lastGoodUsage,
  onUsageResult,
  signInNeeded,
  type Result,
  type UsageResponse,
} from "../usage.js";
import { tileState } from "../tile-state.js";
import { renderError, renderLoading } from "../render.js";
import { openSettings, type OpenSettings } from "../open-settings.js";
import { openSignIn } from "../sign-in.js";

// Every usage key refreshes on the same cadence; the shared per-account cache
// in usage.ts keeps that to one HTTP call per account per CACHE_TTL_MS.
const REFRESH_MS = 3 * 60_000;

// Chosen in the key's Property Inspector (ui/account.html).
export type UsageKeySettings = OpenSettings & { account?: string };

type KeyState = { timer: NodeJS.Timeout; account: Account };

// Shared lifecycle for the four usage keys: per-key account choice, refresh
// timer, tap-to-refresh. Subclasses only decide what to draw from the data.
export abstract class UsageKeyAction extends SingletonAction<UsageKeySettings> {
  private readonly keys = new Map<string, KeyState>();
  // Live key handles, so a fetch made for one key (or by the sign-in
  // watcher) redraws every key of this type showing that account.
  private readonly handles = new Map<string, KeyAction<UsageKeySettings>>();

  constructor() {
    super();
    onUsageResult((account, r) => {
      for (const [id, key] of this.keys) {
        const action = this.handles.get(id);
        if (action && key.account === account) void this.draw(action, account, r);
      }
    });
  }

  // Label shown while loading or on error.
  protected abstract readonly label: string;

  protected abstract render(data: UsageResponse, badge: string, stale?: string): string;

  override async onWillAppear(ev: WillAppearEvent<UsageKeySettings>): Promise<void> {
    if (!ev.action.isKey()) return;
    const action = ev.action;
    const account = accountById(ev.payload.settings.account);
    // Register the timer before the first (awaited) tick so a key removed
    // mid-fetch is still cleaned up by onWillDisappear.
    const timer = setInterval(() => void this.tick(action), REFRESH_MS);
    this.keys.set(action.id, { timer, account });
    this.handles.set(action.id, action);
    await action.setImage(renderLoading(this.label, account.badge));
    await this.tick(action);
  }

  override onWillDisappear(ev: WillDisappearEvent<UsageKeySettings>): void {
    const key = this.keys.get(ev.action.id);
    if (key) clearInterval(key.timer);
    this.keys.delete(ev.action.id);
    this.handles.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<UsageKeySettings>): Promise<void> {
    if (!ev.action.isKey()) return;
    const key = this.keys.get(ev.action.id);
    if (!key) return;
    key.account = accountById(ev.payload.settings.account);
    await ev.action.setImage(renderLoading(this.label, key.account.badge));
    await this.tick(ev.action);
  }

  override async onKeyDown(ev: KeyDownEvent<UsageKeySettings>): Promise<void> {
    const key = this.keys.get(ev.action.id);
    const account = key?.account ?? accountById(ev.payload.settings.account);
    // Account needs signing in: open Terminal on the sign-in instead. No
    // fetch here — a renewal running alongside the sign-in could race it;
    // the sign-in watcher redraws every key once the new login lands.
    if (signInNeeded(account) && (await openSignIn(account))) return;
    // Otherwise a tap forces a fresh fetch — useful for recovery after
    // sleep — and opens the Settings page in that account's browser
    // profile, in parallel so the user isn't waiting on the network call.
    invalidateUsageCache(account);
    if (ev.action.isKey()) void this.tick(ev.action);
    await openSettings(account, ev.payload.settings);
  }

  private async tick(action: KeyAction<UsageKeySettings>): Promise<void> {
    const key = this.keys.get(action.id);
    if (!key) return;
    const { account } = key;
    const r = await getUsage(account);
    await this.draw(action, account, r);
  }

  private async draw(action: KeyAction<UsageKeySettings>, account: Account, r: Result<UsageResponse>): Promise<void> {
    // The account may have been switched while the fetch was in flight.
    if (this.keys.get(action.id)?.account !== account) return;
    // On a temporary failure keep the last good numbers (marked old after
    // 15 min); a failure the user must fix shows "!" with its reason so old
    // numbers don't hide it.
    const tile = tileState(r, lastGoodUsage(account));
    await action.setImage(
      tile.kind === "data"
        ? this.render(tile.data, account.badge, tile.stale)
        : renderError(this.label, account.badge, undefined, tile.hint)
    );
  }
}
