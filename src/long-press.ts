// Tap vs hold on one key, kept free of Stream Deck imports so
// scripts-check-memory.mjs can test it.
//
// The long action fires while the key is still held (once HOLD_MS has
// passed), so you know it worked without letting go; the tap action fires on
// release, and only when the hold action hasn't.

export const HOLD_MS = 500;

export class PressTimer {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private held = new Set<string>();

  private readonly holdMs: number;

  // Plain field, not a parameter property: the check scripts run this file
  // through Node's type stripping, which can't handle parameter properties.
  constructor(holdMs = HOLD_MS) {
    this.holdMs = holdMs;
  }

  /** Key down: run `onHold` if the key is still down after holdMs. */
  down(id: string, onHold: () => void): void {
    this.cancel(id);
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        this.held.add(id);
        onHold();
      }, this.holdMs)
    );
  }

  /** Key up: "tap" if released before holdMs, "hold" if onHold already ran, "none" without a down. */
  up(id: string): "tap" | "hold" | "none" {
    if (this.held.delete(id)) return "hold";
    const t = this.timers.get(id);
    if (!t) return "none";
    clearTimeout(t);
    this.timers.delete(id);
    return "tap";
  }

  /** Key went away mid-press: forget it without firing anything. */
  cancel(id: string): void {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    this.held.delete(id);
  }
}
