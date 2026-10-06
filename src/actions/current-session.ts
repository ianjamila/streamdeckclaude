import { action } from "@elgato/streamdeck";
import { findLimit, type UsageResponse } from "../usage.js";
import { formatPercent, formatResetsIn, renderError, renderKey } from "../render.js";
import { UsageKeyAction } from "./usage-key.js";

@action({ UUID: "com.aaronholt.claude-usage.current" })
export class CurrentSessionAction extends UsageKeyAction {
  protected readonly label = "SESSION";

  protected render(data: UsageResponse, badge: string, stale?: string): string {
    const entry = findLimit(data, "session");
    const percent = entry?.percent ?? data.five_hour?.utilization;
    const resetsAt = entry?.resets_at ?? data.five_hour?.resets_at;
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
