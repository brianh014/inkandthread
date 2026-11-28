import { expect, test } from "bun:test";
import { join } from "node:path";
import { phoneAliases } from "../scripts/phone-aliases";

// What a browser lacks, which shared server code must not use, as the phone app runs it in a worker (ADR 0006). The
// bundle step itself fails on a Node module or file call the phone build doesn't stand in for.
const BROWSER_LACKS = [/\bBuffer\b/, /\bBun\.[a-z]/, /\.unref\(\)/, /\bprocess\.(?!env\b)\w+/];

test("the phone app's server bundles, and its shared code uses nothing a browser lacks", async () => {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "../src/browser/server-worker.ts")],
    target: "browser",
    format: "esm",
    plugins: [phoneAliases],
  });
  expect(built.logs.filter((entry) => entry.level === "error")).toEqual([]);
  const code = await built.outputs[0]!.text();
  // Unminified, Bun marks where each module starts with a `// path` line; only the server's own are checked, not packages.
  const modules = code
    .split(/^\/\/ (?=\S+$)/m)
    .slice(1)
    .filter((module) => module.startsWith("src/"));
  expect(modules.length).toBeGreaterThan(30);
  const found = modules.flatMap((module) => {
    const name = module.slice(0, module.indexOf("\n"));
    return BROWSER_LACKS.filter((pattern) => pattern.test(module.slice(name.length))).map((pattern) => `${name}: ${pattern}`);
  });
  expect(found).toEqual([]);
}, 30_000);
