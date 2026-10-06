// Builds the macOS CPU-temperature helper into the plugin's bin/ folder.
// Skipped on other platforms (the CPU Temp key shows "n/a" there).
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

if (process.platform !== "darwin") {
  console.log("cputemp: skipped (not macOS)");
  process.exit(0);
}
mkdirSync("com.aaronholt.claude-usage.sdPlugin/bin", { recursive: true });
execFileSync(
  "clang",
  [
    "-O2", "-Wall", "-Wextra",
    "-arch", "arm64", "-arch", "x86_64",
    "-mmacosx-version-min=12.0",
    "-framework", "IOKit",
    "-o", "com.aaronholt.claude-usage.sdPlugin/bin/cputemp",
    "native/cputemp.c",
  ],
  { stdio: "inherit" }
);
console.log("cputemp: built");
