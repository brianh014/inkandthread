import { join } from "node:path";
import type { BunPlugin } from "bun";

const browser = join(import.meta.dir, "../src/browser");

/**
 * The phone build's one difference in the server code (ADR: one server, two hosts): `bun:sqlite` and `node:fs` and `node:async_hooks`
 * become the browser versions in `src/browser`. Anything else Node-only fails the build.
 */
export const phoneAliases: BunPlugin = {
  name: "phone aliases",
  setup(build) {
    build.onResolve({ filter: /^bun:sqlite$/ }, () => ({ path: join(browser, "sqlite.ts") }));
    build.onResolve({ filter: /^(node:)?fs$/ }, () => ({ path: join(browser, "fs.ts") }));
    build.onResolve({ filter: /^(node:)?async_hooks$/ }, () => ({ path: join(browser, "async-hooks.ts") }));
  },
};
