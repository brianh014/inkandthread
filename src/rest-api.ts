import { z } from "zod";
import { comfyImages, comfyModels } from "./comfyui";
import { errorResponse, isLoopback, logged, NoFields, parseBody, type ServerOptions } from "./http";
import { log } from "./logger";
import { MAX_IMPORT_BYTES } from "./save-store";
import { serverRoutes } from "./server-routes";
import { relaunch, updater } from "./updater";
import spa from "./web/index.html";

/** `?fresh=1` asks GitHub now, rather than within the last few hours. */
const UpdateCheck = z.strictObject({ fresh: z.literal("1").optional() });

/** The desktop's server: the shared routes (`server-routes.ts`) on `Bun.serve`, with the page, ComfyUI, Quit and updates. */
export function startServer(given: ServerOptions) {
  // Held here, not in Settings, as it's only how the last job went. It's safe to show, unlike the log.
  // shortcut: a restart clears it and an open Settings screen doesn't update, poll or store it if players miss failures.
  const workflow = { problem: "" };
  const draw = given.localImages ?? comfyImages(given.settings, undefined, (problem) => (workflow.problem = problem));
  const { routes, working } = serverRoutes(given, { draw, models: comfyModels, workflow });
  // Requests in flight, a Turn's save among them, finish first.
  // Once the server hands over to a new version, this process only waits on it, so it never quits by itself.
  let restarting = false;
  const quit = (why: string) => {
    if (restarting) return;
    log.startup(`Ink & Thread is closing: ${why}`);
    void server.stop().finally(() => process.exit(0));
  };
  const updates = updater(given.latestRelease);

  // Pages check in, and the app quits once none has for `idleMs`, after any Turn, picture or world is done.
  let pageSeen = Date.now();
  if (given.quittable) {
    const { idleMs } = given.quittable;
    const every = Math.min(30_000, idleMs / 3);
    let ticked = Date.now();
    setInterval(() => {
      const now = Date.now();
      // The computer slept, pages and all, so they get the time to check in again.
      if (now - ticked > every * 2) pageSeen = now;
      ticked = now;
      // A request still running, such as Enhance, would lose its work, so it finishes first.
      if (now - pageSeen > idleMs && !working() && server.pendingRequests === 0) quit("no page has been open for a while");
    }, every).unref();
  }

  const server = Bun.serve({
    hostname: given.hostname ?? "127.0.0.1",
    port: given.port,
    // Not hot reload, whose client copies an uncaught page error's words to the terminal, and they can quote the story.
    development: process.env.NODE_ENV !== "production" && { hmr: false },
    // A Turn can stay silent past Bun's default, which would drop the client while the Turn went on to commit.
    idleTimeout: 0,
    // Bun's default of 128 MiB is less than a Save with images. It answers 413 itself past this, before any route runs.
    maxRequestBodySize: MAX_IMPORT_BYTES + 1,
    routes: logged(
      {
        "/": spa,
        // The download has no window to close, so the Menu's Quit ends it. A server doesn't quit, as everyone on the network shares it.
        "/quit": {
          POST: () => {
            if (!given.quittable) return Response.json({ error: "Not found" }, { status: 404 });
            quit("the player quit");
            return new Response(null, { status: 204 });
          },
        },
        // A new version: whether there is one, and installing it, which restarts the server once this answer is sent.
        "/update": {
          GET: async (req) => Response.json(await updates.status(UpdateCheck.parse(Object.fromEntries(new URL(req.url).searchParams)).fresh === "1")),
          POST: async (req) => {
            await parseBody(req, NoFields);
            if (working()) return Response.json({ error: "Wait for the story, its pictures and any new world to finish, then update." }, { status: 409 });
            const installed = await updates.install();
            restarting = true;
            void (async () => {
              // A Turn, picture or world begun during the download finishes first, as stopping the server doesn't wait for them.
              // shortcut: new work can still start while this waits; refuse it with a 503 if players hit that.
              while (working()) await Bun.sleep(1000);
              await server.stop();
              await relaunch();
            })();
            return Response.json(installed, { status: 202 });
          },
        },
        "/alive": {
          POST: () => {
            pageSeen = Date.now();
            return new Response(null, { status: 204 });
          },
        },
        ...routes,
      },
      isLoopback(given.hostname ?? "127.0.0.1"),
    ),
    fetch: () => {
      log.verbose("http", "No such route");
      return Response.json({ error: "Not found" }, { status: 404 });
    },
    error: errorResponse,
  });
  return server;
}
