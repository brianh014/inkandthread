/**
 * Builds the phone app as static files (ADR 0006): the page, its server worker, the service worker and SQLite's WASM.
 * `bun scripts/build-phone.ts [--fake] [--out dist/phone]`. `--fake` puts in the stand-in Narrator and pictures, as the
 * desktop's --fake, for tests and trying the build with no key.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { version } from "../package.json";
import { phoneAliases } from "./phone-aliases";

const root = join(import.meta.dir, "..");
const browser = join(root, "src/browser");

/** The hosted services the phone app calls, the only places its page may send anything (ticket 01 of .scratch/phone-app). */
const PROVIDERS = ["https://openrouter.ai", "https://generativelanguage.googleapis.com", "https://api.nano-gpt.com"];
const THEME = "#1f3a2c";

const MANIFEST = {
  name: "Ink & Thread",
  short_name: "Ink & Thread",
  description: "A choose-your-own visual novel, written as you play.",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: THEME,
  theme_color: THEME,
  icons: [192, 512].map((size) => ({ src: `/icon-${size}.png`, sizes: `${size}x${size}`, type: "image/png" })),
};

// Imported Saves and model replies are untrusted, and the page shares its origin with the stored keys, so the page may
// load only its own files and send only to the providers. (The server worker's own calls aren't covered: a static host
// can't set its headers.)
const POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  `connect-src 'self' ${PROVIDERS.join(" ")}`,
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

const HEAD = [
  `<meta http-equiv="Content-Security-Policy" content="${POLICY}" />`,
  `<meta name="theme-color" content="${THEME}" />`,
  '<link rel="manifest" href="/manifest.webmanifest" />',
  '<link rel="apple-touch-icon" href="/icon-180.png" />',
].join("\n    ");

export async function buildPhone({ outdir, fake = false }: { outdir: string; fake?: boolean }) {
  // The folder is emptied first, so only an empty one or an earlier build, which has sw.js, never a stray --out such as the repo.
  if (existsSync(outdir) && readdirSync(outdir).length > 0 && !existsSync(join(outdir, "sw.js")))
    throw new Error(`${outdir} holds files that aren't a phone build, so it isn't emptied for one`);
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
  for (const size of [180, 192, 512]) copyFileSync(join(browser, `icon-${size}.png`), join(outdir, `icon-${size}.png`));
  writeFileSync(join(outdir, "manifest.webmanifest"), JSON.stringify(MANIFEST, null, 2));
  const page = join(outdir, "index.html");
  writeFileSync(page, readFileSync(page, "utf8").replace("</head>", `  ${HEAD}\n  </head>`));
  // The service worker last, as it lists everything else the build made, which it leaves to load as files.
  const files = readdirSync(outdir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `/${relative(outdir, join(entry.parentPath, entry.name)).replaceAll("\\", "/")}`);
  // A new name for each build's cache, so an update is fetched whole and the last build's files are dropped.
  const buildName = `${version}-${Date.now().toString(36)}`;
  await build({
    ...common,
    entrypoints: [join(browser, "sw.ts")],
    naming: "sw.js",
    define: { ...common.define, STATIC_FILES: JSON.stringify([...files, "/sw.js"]), BUILD: JSON.stringify(buildName) },
  });
  return files;
}

if (import.meta.main) {
  const at = process.argv.indexOf("--out");
  const outdir = resolve(root, at > 0 && process.argv[at + 1] ? process.argv[at + 1]! : "dist/phone");
  const files = await buildPhone({ outdir, fake: process.argv.includes("--fake") });
  console.log(`Built the phone app in ${outdir}: ${files.length + 1} files`);
}
