import { action, type JsonObject } from "@elgato/streamdeck";
import { formatPercent, levelFor, renderKey, SYSTEM_THEME } from "../render.js";
import type { SystemSnapshot } from "../system.js";
import { CpuKeyAction } from "./cpu-key.js";

// Green below 60%, yellow 60–84%, red from 85%.
const MID_PERCENT = 60;
const HOT_PERCENT = 85;

@action({ UUID: "com.aaronholt.claude-usage.cpu-usage" })
export class CpuUsageAction extends CpuKeyAction<JsonObject> {
  protected readonly label = "CPU LOAD";

  protected render(snap: SystemSnapshot): string {
    return renderKey({
      big: formatPercent(snap.usage),
      label: this.label,
      // 1-minute load average against the core count: below the core count
      // there is spare capacity, above it work is queueing. Load average is
      // always 0 on Windows, so show the core count alone there.
      subtitle:
        snap.load > 0 ? `load ${snap.load.toFixed(1)}/${snap.cores}` : `${snap.cores} cores`,
      level: levelFor(snap.usage, MID_PERCENT, HOT_PERCENT),
      spark: snap.usageHistory.map((u) => u / 100),
      theme: SYSTEM_THEME,
    });
  }
}
