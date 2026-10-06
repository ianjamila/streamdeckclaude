import streamDeck, { LogLevel } from "@elgato/streamdeck";

import { verifyUsage } from "./usage.js";
import { CurrentSessionAction } from "./actions/current-session.js";
import { WeeklyAllAction } from "./actions/weekly-all.js";
import { WeeklyScopedAction } from "./actions/weekly-scoped.js";
import { ExtraUsageAction } from "./actions/extra-usage.js";
import { PeakHoursAction } from "./actions/peak-hours.js";
import { CodexUsageAction } from "./actions/codex-usage.js";
import { CpuUsageAction } from "./actions/cpu-usage.js";
import { CpuTempAction } from "./actions/cpu-temp.js";

streamDeck.logger.setLevel(LogLevel.INFO);

streamDeck.actions.registerAction(new CurrentSessionAction());
streamDeck.actions.registerAction(new WeeklyAllAction());
streamDeck.actions.registerAction(new WeeklyScopedAction());
streamDeck.actions.registerAction(new ExtraUsageAction());
streamDeck.actions.registerAction(new PeakHoursAction());
streamDeck.actions.registerAction(new CodexUsageAction());
streamDeck.actions.registerAction(new CpuUsageAction());
streamDeck.actions.registerAction(new CpuTempAction());

void verifyUsage();

streamDeck.connect();
