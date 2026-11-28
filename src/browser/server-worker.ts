/**
 * The phone build's server: the shared routes (`server-routes.ts`) in a dedicated worker of the player's page (ADR 0006).
 * The service worker sends each request here with a MessagePort; the answer goes back on it as a head, body chunks and an
 * end, so a Turn's events stream. Hosted image and text APIs only: no ComfyUI, local command, Quit or updater.
 */
import "./globals";
import { version } from "../../package.json";
import { fakeImages, fakeTextProvider } from "../fake-services";
import { logged, type ServerOptions } from "../http";
import { googleImages, type ImageAdapter, imageModelLists, nanoGptImages, openRouterImages } from "../image-adapter";
import { log, logLinesTo, startLog } from "../logger";
import { serverRoutes } from "../server-routes";
import type { LocalImages } from "../settings-routes";
import { reviewerSettings, settingsStore } from "../settings-store";
import { textProvider } from "../text-provider";
import { usageStore } from "../usage-store";
import { attachLog, keepLogLine, logText } from "./phone-log";
import { keepHeadroom, openStorage } from "./storage";

/** What the service worker sends: the request, its body moved over rather than copied. */
export type Asked = { url: string; method: string; headers: [string, string][]; body: ArrayBuffer | null };
/** What goes back on the request's port, in order: one head, any chunks, one end. */
export type Answer = { head: { status: number; headers: [string, string][] } } | { chunk: Uint8Array } | { end: true };

type Handler = (req: Request, server: unknown) => Response | Promise<Response>;

// Set at build time: the stand-in Narrator and pictures, for tests and trying the build, as the desktop's --fake.
const FAKE = process.env.INKANDTHREAD_PHONE_FAKE === "1";

const unavailable =
  (what: string): ImageAdapter =>
  async () => {
    throw new Error(`${what} isn't available in the phone app`);
  };

/** ComfyUI as the phone offers it: not at all. Settings there never offers it (ticket 11), and these refuse if asked. */
const NO_COMFY: LocalImages = {
  draw: unavailable("ComfyUI"),
  models: async () => ({
    reachable: false,
    hasFlux2: false,
    hasQwen21: false,
    checkpoints: [],
    diffusionModels: [],
    textEncoders: [],
    vaes: [],
    loras: [],
    samplers: [],
    schedulers: [],
  }),
  workflow: { problem: "" },
};

const dice = () => 1 + ((crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) % 20);

async function start() {
  startLog("info");
  const { pool, app, opened } = await openStorage();
  attachLog(app);
  logLinesTo(keepLogLine);
  log.info("saves", "Browser storage opened", opened);
  const settings = settingsStore("/settings.json");
  // As the desktop's --fake on its first run: a model named, so play works at once with nothing real behind it. The address
  // stays the default hosted one, as this app reaches no other; the stand-in Narrator never calls it.
  if (FAKE && !settings.read().textModel)
    settings.update({ textModel: "fake-narrator", textApiKey: "fake-key", imageModel: "fake-images", imageApiKey: "fake-key", tipsSeen: true });
  const online = {
    openrouter: openRouterImages(settings, "https://openrouter.ai/api/v1"),
    // Wiro refuses calls from any web page but its own (ticket 01).
    wiro: unavailable("Wiro"),
    google: googleImages(settings, "https://generativelanguage.googleapis.com/v1"),
    nanogpt: nanoGptImages(settings, "https://api.nano-gpt.com/api/v1"),
  };
  const given: ServerOptions = {
    savesDir: "/Saves",
    settings,
    usage: usageStore("/usage.sqlite"),
    textProvider: FAKE ? fakeTextProvider : textProvider(settings),
    reviewProvider: FAKE ? fakeTextProvider : textProvider(reviewerSettings(settings)),
    moveWorld: true,
    offerChoices: true,
    imageAdapter: FAKE ? fakeImages : online,
    imageModels: FAKE
      ? async () => ["fake-images"]
      : imageModelLists(settings, {
          openRouter: "https://openrouter.ai/api/v1",
          wiro: "https://api.wiro.ai/v1",
          google: "https://generativelanguage.googleapis.com/v1beta",
          nanoGpt: "https://api.nano-gpt.com/api/v1",
        }),
    dice,
    nearMissMargin: 3,
    port: 0,
    ownDevice: true,
    hostedOnly: true,
  };
  const { routes } = serverRoutes(given, NO_COMFY);
  const table = logged(
    {
      // The desktop's idle quit listens for these; a phone page has nothing to keep alive.
      "/alive": { POST: () => new Response(null, { status: 204 }) },
      // shortcut: never a new version yet; ticket 13 of .scratch/phone-app makes it the service worker's update.
      "/update": { GET: () => Response.json({ version, failed: false, latest: null, installable: false }) },
      // The log, for the player to save and send with a bug report, as the desktop's log file.
      "/phone/log": { GET: () => new Response(logText(), { headers: { "Content-Type": "text/plain; charset=utf-8" } }) },
      ...routes,
    } as never,
    false,
  ) as Record<string, Record<string, Handler>>;
  log.info("http", "Phone server started", { routes: Object.keys(table).length, fake: FAKE });
  return { pool, routes: Object.entries(table).map(([path, methods]) => ({ parts: path.split("/"), methods })) };
}

type Route = { parts: string[]; methods: Record<string, Handler> };

/** The route table's paths, `:name` matching one part, as Bun.serve's do. */
function match(routes: Route[], pathname: string) {
  const parts = pathname.split("/");
  for (const route of routes) {
    if (route.parts.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const fits = route.parts.every((part, i) => {
      if (!part.startsWith(":")) return part === parts[i];
      params[part.slice(1)] = decodeURIComponent(parts[i]!);
      return true;
    });
    if (fits) return { route, params };
  }
  return undefined;
}

// Bun.Server where a handler asks for one; ownDevice already answers "this computer" on the phone.
const server = { requestIP: () => ({ address: "127.0.0.1" }) };

/** Import holds several copies of a Save at once, which a phone's memory may not; the desktop takes far larger ones. */
const MOST_BODY_BYTES = 100 * 1024 * 1024;

async function answer(asked: Asked, stop: AbortSignal): Promise<Response> {
  if ((asked.body?.byteLength ?? 0) > MOST_BODY_BYTES)
    return Response.json({ error: "This file is too large for the phone app. Open it in the desktop app instead." }, { status: 413 });
  let started: Awaited<ReturnType<typeof start>>;
  try {
    started = await ready;
  } catch (error) {
    // Storage held by another tab, or a browser without what the app needs: every request says why, so the page shows it.
    return Response.json({ error: (error as Error).message }, { status: 503 });
  }
  await keepHeadroom(started.pool);
  const url = new URL(asked.url);
  const found = match(started.routes, url.pathname);
  const handler = found?.route.methods[asked.method];
  if (!handler) {
    log.verbose("http", "No such route");
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const req = Object.assign(new Request(url, { method: asked.method, headers: asked.headers, body: asked.body, signal: stop }), { params: found!.params });
  return handler(req, server);
}

const ready = start();

addEventListener("message", async ({ data, ports: [port] }: MessageEvent<Asked>) => {
  if (!port) return;
  const send = (message: Answer, moved: Transferable[] = []) => port.postMessage(message, moved);
  // The page let go of the request, as a closed Enhance does: the handler hears it, as it would from Bun.
  const stop = new AbortController();
  port.onmessage = ({ data: said }) => said === "abort" && stop.abort();
  let headed = false;
  try {
    const response = await answer(data, stop.signal);
    send({ head: { status: response.status, headers: [...response.headers] } });
    headed = true;
    const reader = response.body?.getReader();
    for (;;) {
      const read = await reader?.read();
      if (!read || read.done) break;
      send({ chunk: read.value }, [read.value.buffer]);
    }
  } catch (error) {
    log.error("http", "The phone server failed a request", { message: (error as Error).message });
    // Once the head is gone, the page's reader sees the body end early, as a dropped connection.
    if (!headed) {
      send({ head: { status: 500, headers: [["content-type", "application/json"]] } });
      send({ chunk: new TextEncoder().encode(JSON.stringify({ error: "Internal server error" })) });
    }
  }
  send({ end: true });
  port.close();
});
