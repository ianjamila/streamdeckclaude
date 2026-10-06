import { action } from "@elgato/streamdeck";
import { levelFor, renderKey, SYSTEM_THEME } from "../render.js";
import { toFahrenheit, type SystemSnapshot } from "../system.js";
import { CpuKeyAction } from "./cpu-key.js";

// Chosen in the key's Property Inspector (ui/cpu-temp.html).
type Settings = { unit?: string; show?: string };

// Colour thresholds in °C: green below MID, yellow from MID, red from HOT.
// Apple Silicon hot spots routinely pass 90 °C under load, so the
// hottest-core reading gets higher bars than the average.
const AVG_C = { mid: 70, hot: 90 };
const MAX_C = { mid: 85, hot: 100 };
// Sparkline range, °C.
const SPARK_MIN_C = 30;
const SPARK_MAX_C = 110;

export function formatTemp(c: number, unit: "c" | "f"): string {
  return `${Math.round(unit === "f" ? toFahrenheit(c) : c)}°`;
}

@action({ UUID: "com.aaronholt.claude-usage.cpu-temp" })
export class CpuTempAction extends CpuKeyAction<Settings> {
  protected readonly label = "CPU TEMP";

  protected render(snap: SystemSnapshot, settings: Settings): string {
    const unit = settings.unit === "f" ? "f" : "c";
    const showMax = settings.show === "max";
    const t = snap.temp;
    if (!t) {
      return renderKey({
        big: "—",
        label: this.label,
        subtitle: snap.tempError,
        theme: SYSTEM_THEME,
      });
    }
    const big = showMax ? t.max : t.avg;
    return renderKey({
      big: formatTemp(big, unit),
      label: this.label,
      subtitle: showMax ? `avg ${formatTemp(t.avg, unit)}` : `max ${formatTemp(t.max, unit)}`,
      level: showMax
        ? levelFor(t.max, MAX_C.mid, MAX_C.hot)
        : levelFor(t.avg, AVG_C.mid, AVG_C.hot),
      spark: snap.tempHistory.map((c) => (c - SPARK_MIN_C) / (SPARK_MAX_C - SPARK_MIN_C)),
      theme: SYSTEM_THEME,
    });
  }
}
