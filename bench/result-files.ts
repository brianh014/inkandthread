import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The result files: each `.json` in `results`, all named for their run, and each run's `result.json` in `runs`, not a judge's
 * scores saved beside it, which `bun bench judge` once read as a result and crashed on.
 */
export function resultFiles(results: string, runs: string) {
  const found: string[] = [];
  const walk = (folder: string, take: (name: string) => boolean) => {
    if (!existsSync(folder)) return;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path, take);
      else if (take(entry.name)) found.push(path);
    }
  };
  walk(results, (name) => name.endsWith(".json"));
  walk(runs, (name) => name === "result.json");
  return found;
}
