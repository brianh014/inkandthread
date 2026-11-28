import { z } from "zod";
import { galleryRoutes } from "./gallery-routes";
import { parseBody, type ServerContext, type ServerOptions } from "./http";
import type { ImageAdapter } from "./image-adapter";
import { imagePipeline } from "./image-pipeline";
import { liveTurns } from "./live-turns";
import { errorFields, log, setLogLevel } from "./logger";
import { saveRoutes } from "./save-routes";
import { saveStore } from "./save-store";
import { type LocalImages, settingsRoutes } from "./settings-routes";
import { OnlineImageProvider, reviewerSettings } from "./settings-store";
import { turnRoutes } from "./turn-routes";
import { countedImages, countedText, usageStore } from "./usage-store";
import { worldBuilds } from "./world-builds";
import { reviewScenePrompt, writePicturePrompt } from "./world-creation";
import { worldRoutes } from "./world-routes";

// What the page may say. Strict and numbers only, as the app listens on the network, so nothing the page holds can reach the log.
const PAGE_EVENTS = {
  "stream-lost": "info",
  "polling-fallback": "verbose",
  "turn-resumed": "info",
  "world-build-picked-up": "info",
  "polling-gave-up": "warning",
  "narration-restarted": "info",
  "page-error": "error",
} as const;

const pageNumber = z.number().finite().optional();

// A Save's id isn't free text, and the line would be no use without it.
const PageEvent = z.strictObject({
  event: z.enum(Object.keys(PAGE_EVENTS) as (keyof typeof PAGE_EVENTS)[]),
  save: z.uuid().optional(),
  after: pageNumber,
  misses: pageNumber,
  returned: pageNumber,
  line: pageNumber,
  column: pageNumber,
});

const MOST_PAGE_EVENT_BYTES = 1024;

/** Every online provider's adapter, from one given for all or from a list that names each. */
const onlineAdapters = (given: ServerOptions["imageAdapter"]) =>
  typeof given === "function"
    ? (Object.fromEntries(OnlineImageProvider.options.map((provider) => [provider, given])) as Record<OnlineImageProvider, ImageAdapter>)
    : given;

/** Stops reading at the cap, as a Save's import needs the server's own limit to be huge. */
async function cappedBody(req: Request) {
  let bytes = 0;
  const parts: Uint8Array<ArrayBuffer>[] = [];
  for await (const part of req.body ?? []) {
    bytes += part.byteLength;
    if (bytes > MOST_PAGE_EVENT_BYTES) return undefined;
    parts.push(part);
  }
  return new Request(req.url, { method: "POST", headers: req.headers, body: new Blob(parts) });
}

/**
 * One server's parts, and its routes put together by area, which every host serves: the desktop through `Bun.serve`
 * (`rest-api.ts`), the phone build in the page's worker (ADR 0006). Each area is its own module, sharing only the Saves,
 * Turns and images. `local` is ComfyUI as the host offers it.
 */
export function serverRoutes(given: ServerOptions, local: LocalImages) {
  const { settings } = given;
  const usage = given.usage ?? usageStore();
  // Counted here, before anything holds the Text Provider, so every call for every route and picture prompt is counted.
  const options = {
    ...given,
    usage,
    textProvider: countedText(given.textProvider, usage, settings),
    reviewProvider: given.reviewProvider && countedText(given.reviewProvider, usage, reviewerSettings(settings)),
  };
  const saves = saveStore(options.savesDir);
  const turns = liveTurns();
  const builds = worldBuilds();
  try {
    setLogLevel(settings.read().logLevel);
  } catch (error) {
    // Settings that won't read are every request's problem, not a reason not to start.
    log.error("settings", "Settings won't read", errorFields(error));
  }
  // Settings' test picture goes through the counted one too, as Usage counts every request.
  const adapters = countedImages({ ...onlineAdapters(options.imageAdapter), local: local.draw }, usage, settings);
  const images = imagePipeline(
    saves,
    adapters,
    settings,
    options.writePicture ?? ((ask, style, _template, signal) => writePicturePrompt(options, ask, style, signal)),
    options.reviewPicture ?? ((description, style, signal, cast, moment) => reviewScenePrompt(options, description, style, signal, cast, moment)),
  );
  const context: ServerContext = { options, saves, turns, images, builds };

  return {
    /** What goes on without the request that started it. */
    working: () => turns.busy() || images.busy() || builds.busy(),
    routes: {
      "/log": {
        POST: async (req: Request) => {
          const capped = await cappedBody(req);
          if (!capped) return Response.json({ error: "Too long" }, { status: 400 });
          const { event, ...fields } = await parseBody(capped, PageEvent);
          log[PAGE_EVENTS[event]]("page", event, fields);
          return new Response(null, { status: 204 });
        },
      },
      ...settingsRoutes(context, { ...local, draw: adapters.local }),
      ...worldRoutes(context),
      ...saveRoutes(context),
      ...turnRoutes(context),
      ...galleryRoutes(context),
    },
  };
}
