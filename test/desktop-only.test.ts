import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Programs, ComfyUI and self-update need a computer. The hosts (main, rest-api) may reach them; the shared server code a
// browser could also run must not, directly or through another module (ticket 08 of .scratch/phone-app).
const DESKTOP_ONLY = new Set(["updater", "comfyui", "command-provider"]);
const HOSTS = new Set(["main", "rest-api"]);

const src = join(import.meta.dir, "../src");
const importsOf = (name: string) =>
  [...readFileSync(join(src, `${name}.ts`), "utf8").matchAll(/^import (?!type )[^;]*?from "\.\/([\w-]+)"/gm)].map(([, module]) => module!);

test("shared server code never reaches desktop-only modules", () => {
  const shared = readdirSync(src)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => file.slice(0, -3))
    .filter((name) => !DESKTOP_ONLY.has(name) && !HOSTS.has(name));
  const reached = shared.flatMap((name) => {
    const seen = new Set<string>();
    const walk = (module: string, path: string[]): string[] =>
      importsOf(module).flatMap((next) => {
        if (DESKTOP_ONLY.has(next)) return [[...path, next].join(" → ")];
        if (seen.has(next) || HOSTS.has(next) || !readdirSync(src).includes(`${next}.ts`)) return [];
        seen.add(next);
        return walk(next, [...path, next]);
      });
    return walk(name, [name]);
  });
  expect(reached).toEqual([]);
});
