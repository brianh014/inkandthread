/**
 * Builds the phone app as static files (ADR 0006): the page, its server worker, the service worker and SQLite's WASM.
 * `bun scripts/build-phone.ts [--fake] [--out dist/phone]`. `--fake` puts in the stand-in Narrator and pictures, as the
 * desktop's --fake, for tests and trying the build with no key.
 */
import { copyFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { phoneAliases } from "./phone-aliases";

const root = join(import.meta.dir, "..");
const browser = join(root, "src/browser");

export async function buildPhone({ outdir, fake = false }: { outdir: string; fake?: boolean }) {
  rmSync(outdir, { recursive: true, force: true });
  const common = { outdir, target: "browser", format: "esm", minify: true, define: { "process.env.NODE_ENV": '"production"' } } as const;
  const build = async (options: Parameters<typeof Bun.build>[0]) => {
    const built = await Bun.build(options);
    if (!built.success) throw new AggregateError(built.logs, `The phone build failed: ${options.entrypoints.join(", ")}`);
  };
  await build({
    ...common,
    entrypoints: [join(browser, "server-worker.ts")],
    naming: "server-worker.js",
    plugins: [phoneAliases],
    define: { ...common.define, "process.env.INKANDTHREAD_PHONE_FAKE": fake ? '"1"' : '""' },
  });
  await build({ ...common, entrypoints: [join(browser, "index.html")], naming: { asset: "[name]-[hash].[ext]" } });
  copyFileSync(join(root, "node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm"), join(outdir, "sqlite3.wasm"));
  // The service worker last, as it lists everything else the build made, which it leaves to load as files.
  const files = readdirSync(outdir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `/${relative(outdir, join(entry.parentPath, entry.name)).replaceAll("\\", "/")}`);
  await build({
    ...common,
    entrypoints: [join(browser, "sw.ts")],
    naming: "sw.js",
    define: { ...common.define, STATIC_FILES: JSON.stringify([...files, "/sw.js"]) },
  });
  return files;
}

if (import.meta.main) {
  const at = process.argv.indexOf("--out");
  const outdir = join(root, at > 0 ? process.argv[at + 1]! : "dist/phone");
  const files = await buildPhone({ outdir, fake: process.argv.includes("--fake") });
  console.log(`Built the phone app in ${outdir}: ${files.length + 1} files`);
}
