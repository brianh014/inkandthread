// The phone app, built with --fake into a fresh folder and served as a static site, for phone-play.spec.ts.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPhone } from "../../scripts/build-phone";

const out = mkdtempSync(join(tmpdir(), "phone-e2e-"));
await buildPhone({ outdir: out, fake: true });

Bun.serve({
  port: Number(process.env.PHONE_PORT ?? 4636),
  hostname: "127.0.0.1",
  async fetch(req) {
    const { pathname } = new URL(req.url);
    // For the update check in phone-play.spec.ts: a new build at the same address, as a release would publish.
    if (pathname === "/__rebuild" && req.method === "POST") {
      await buildPhone({ outdir: out, fake: true });
      return new Response(null, { status: 204 });
    }
    const file = Bun.file(join(out, pathname === "/" ? "index.html" : pathname));
    // As a static host: the build's files, and 404 for anything else, which only the service worker answers.
    return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 });
  },
});
