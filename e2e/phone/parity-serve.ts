// Serves phone-storage.spec.ts both halves on PHONE_PARITY_PORT: the scenario run on Bun, and the browser half to run.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { phoneAliases } from "../../scripts/phone-aliases";
import { saveStore } from "../../src/save-store";
import { usageStore } from "../../src/usage-store";
import { storageScenario } from "./storage-scenario";

const desktopFolder = mkdtempSync(join(tmpdir(), "phone-parity-"));
const desktop = storageScenario(saveStore(join(desktopFolder, "Saves")), usageStore(":memory:"));
rmSync(desktopFolder, { recursive: true, force: true });

const out = mkdtempSync(join(tmpdir(), "phone-parity-build-"));
const built = await Bun.build({
  entrypoints: [join(import.meta.dir, "parity-worker.ts"), join(import.meta.dir, "lock-worker.ts")],
  outdir: out,
  target: "browser",
  format: "esm",
  plugins: [phoneAliases],
});
if (!built.success) throw new AggregateError(built.logs, "The phone parity worker didn't build");
const wasm = join(import.meta.dir, "../../node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm");

const page = `<!doctype html><meta charset="utf-8"><title>parity</title><script type="module">
const worker = new Worker("/parity-worker.js", { type: "module" });
window.parityWorker = worker;
window.parity = new Promise((done) => { worker.onmessage = ({ data }) => done(data); worker.onerror = (e) => done({ error: e.message }); });
</script>`;

Bun.serve({
  port: Number(process.env.PHONE_PARITY_PORT ?? 4635),
  hostname: "127.0.0.1",
  routes: {
    "/desktop.json": Response.json(desktop),
    "/": new Response(page, { headers: { "Content-Type": "text/html" } }),
    "/parity-worker.js": new Response(Bun.file(join(out, "parity-worker.js")), { headers: { "Content-Type": "text/javascript" } }),
    "/lock-worker.js": new Response(Bun.file(join(out, "lock-worker.js")), { headers: { "Content-Type": "text/javascript" } }),
    "/sqlite3.wasm": new Response(Bun.file(wasm), { headers: { "Content-Type": "application/wasm" } }),
  },
});
