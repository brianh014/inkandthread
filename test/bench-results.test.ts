import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resultFiles } from "../bench/result-files";
import { tempFolder } from "./support";

test("the bench reads only result files, not a judge's scores saved in a run's folder", () => {
  const folder = tempFolder();
  const results = join(folder.path, "results", "host", "model");
  const run = join(folder.path, "runs", "host", "model", "a-run");
  mkdirSync(results, { recursive: true });
  mkdirSync(run, { recursive: true });
  for (const path of [join(results, "a-run.json"), join(run, "result.json"), join(run, "judge-scores.json")]) writeFileSync(path, "{}");

  expect(resultFiles(join(folder.path, "results"), join(folder.path, "runs"))).toEqual([join(results, "a-run.json"), join(run, "result.json")]);
  folder.remove();
});
