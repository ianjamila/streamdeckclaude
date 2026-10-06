import { action } from "@elgato/streamdeck";
import { findLimit, type UsageResponse } from "../usage.js";
import { formatPercent, formatResetsIn, renderKey } from "../render.js";
import { UsageKeyAction } from "./usage-key.js";

const FALLBACK_LABEL = "MODEL";

function labelFor(name: string | null | undefined): string {
  if (!name) return FALLBACK_LABEL;
  return name.toUpperCase().slice(0, 10);
}

@action({ UUID: "com.aaronholt.claude-usage.weekly-scoped" })
export class WeeklyScopedAction extends UsageKeyAction {
  protected readonly label = FALLBACK_LABEL;

  protected render(data: UsageResponse, badge: string, stale?: string): string {
    const entry = findLimit(data, "weekly_scoped");
    if (!entry) {
      // No scoped model bucket on this account — show a dash so the key isn't
      // stuck in error state.
      return renderKey({ big: "—", label: FALLBACK_LABEL, subtitle: "none active", badge, stale });
    }
    return renderKey({
      big: formatPercent(entry.percent),
      label: "7D " + labelFor(entry.scope?.model?.display_name),
      subtitle: formatResetsIn(entry.resets_at),
      accent: entry.percent > 80,
      badge,
      stale,
    });
  }
}
