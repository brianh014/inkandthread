/**
 * The phone build's service worker (ADR 0006). The build's own files load as on any site; every other request on this
 * origin is the server's, pictures in `<img src>` and Save downloads included, so it goes to the page's server worker.
 * It takes over only on a reload, never part way through a page's life, so it never changes under a running Turn.
 */
/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;
import type { Answer, Asked } from "./server-worker";

// The build's files and its name, set by scripts/build-phone.ts, so the server's routes are never listed twice.
declare const STATIC_FILES: string[];
declare const BUILD: string;
const files = new Set(STATIC_FILES);
const CACHE = `inkandthread-${BUILD}`;

// The whole build is kept, so the app opens with no connection; only the AI needs one.
self.addEventListener("install", (event) =>
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(["/", ...STATIC_FILES.filter((file) => file !== "/sw.js")]))),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.filter((name) => name.startsWith("inkandthread-") && name !== CACHE).map((name) => caches.delete(name)))),
  ),
);

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname === "/" || files.has(url.pathname))
    event.respondWith(caches.match(url.pathname, { cacheName: CACHE }).then((kept) => kept ?? fetch(event.request)));
  else event.respondWith(forward(event));
});

/** The page that asked; for a download link, which has none, the one open window, as the Saves allow only one. */
async function asker(event: FetchEvent) {
  if (event.clientId) return self.clients.get(event.clientId);
  const [first] = await self.clients.matchAll({ type: "window" });
  return first;
}

async function forward(event: FetchEvent) {
  const page = await asker(event);
  if (!page) return Response.json({ error: "Open Ink & Thread to use it." }, { status: 503 });
  const { request } = event;
  const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
  const asked: Asked = { url: request.url, method: request.method, headers: [...request.headers], body };
  const { port1: here, port2: there } = new MessageChannel();
  page.postMessage(asked, [there, ...(body ? [body] : [])]);
  // A page that lets go of its request, such as a closed Enhance, stops the work it asked for, where the browser says so.
  request.signal?.addEventListener("abort", () => here.postMessage("abort"));
  return new Promise<Response>((answered) => {
    let push!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        push = controller;
      },
    });
    here.onmessage = ({ data }: MessageEvent<Answer>) => {
      if ("head" in data) answered(new Response([101, 204, 205, 304].includes(data.head.status) ? null : stream, data.head));
      else if ("chunk" in data) push.enqueue(data.chunk);
      else {
        push.close();
        here.close();
      }
    };
  });
}
