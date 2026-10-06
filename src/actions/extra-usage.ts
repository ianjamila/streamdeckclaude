import { action } from "@elgato/streamdeck";
import type { UsageResponse } from "../usage.js";
import { formatPercent, formatUsedOfLimit, renderKey } from "../render.js";
import { UsageKeyAction } from "./usage-key.js";

@action({ UUID: "com.aaronholt.claude-usage.extra-usage" })
export class ExtraUsageAction extends UsageKeyAction {
  protected readonly label = "EXTRA";

  protected render(data: UsageResponse, badge: string, stale?: string): string {
    const e = data.extra_usage;
    if (
      !e ||
      !e.is_enabled ||
      typeof e.utilization !== "number" ||
      typeof e.used_credits !== "number" ||
      typeof e.monthly_limit !== "number" ||
      !e.currency
    ) {
      return renderKey({ big: "off", label: this.label, subtitle: "not enabled", badge, stale });
    }
    const pct = e.utilization;
    return renderKey({
      big: formatPercent(pct),
      label: this.label,
      subtitle: formatUsedOfLimit(e.used_credits, e.monthly_limit, e.currency),
      accent: pct > 80,
      badge,
      stale,
    });
  }
}
