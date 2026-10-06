import { action } from "@elgato/streamdeck";
import { findLimit, type UsageResponse } from "../usage.js";
import { formatPercent, formatResetsIn, renderError, renderKey } from "../render.js";
import { UsageKeyAction } from "./usage-key.js";

@action({ UUID: "com.aaronholt.claude-usage.weekly-all" })
export class WeeklyAllAction extends UsageKeyAction {
  protected readonly label = "7D ALL";

  protected render(data: UsageResponse, badge: string, stale?: string): string {
    const entry = findLimit(data, "weekly_all");
    const percent = entry?.percent ?? data.seven_day?.utilization;
    const resetsAt = entry?.resets_at ?? data.seven_day?.resets_at;
    if (typeof percent !== "number") return renderError(this.label, badge);
    return renderKey({
      big: formatPercent(percent),
      label: this.label,
      subtitle: formatResetsIn(resetsAt),
      accent: percent > 80,
      badge,
      stale,
    });
  }
}
