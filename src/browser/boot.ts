/**
 * The phone build's page starts here, before the app (ADR 0006): its server worker, then the service worker that sends
 * the app's requests to it, then the app itself, once the service worker answers for the page.
 */
import type { Asked } from "./server-worker";

const RELOADED = "inkandthread-reloaded-for-service-worker";

const said = (text: string) => {
  document.body.textContent = text;
};

try {
  // The build puts it at the root, beside sw.js; the app is served from the root of its own origin (ticket 16).
  const server = new Worker("/server-worker.js", { type: "module" });
  // Inside the try, as a window with no service worker leaves navigator.serviceWorker undefined.
  navigator.serviceWorker.addEventListener("message", ({ data, ports }: MessageEvent<Asked>) =>
    server.postMessage(data, [...ports, ...(data.body ? [data.body] : [])]),
  );
  navigator.serviceWorker.startMessages();
  await navigator.serviceWorker.register("/sw.js", { type: "module" });
  await navigator.serviceWorker.ready;
  if (navigator.serviceWorker.controller) {
    sessionStorage.removeItem(RELOADED);
    // Kept when the browser runs short of space, where it grants it, as an installed app's storage usually is.
    void navigator.storage?.persist?.().catch(() => false);
    await import("../web/main");
  } else if (!sessionStorage.getItem(RELOADED)) {
    // A first visit, or a hard reload, which skips the service worker: a plain reload brings it in.
    sessionStorage.setItem(RELOADED, "1");
    location.reload();
  } else said("Ink & Thread couldn't start here. Reload the page, or open it in Chrome or Safari.");
} catch {
  // Private browsing and some in-app browsers allow no service worker, and the app has no server without one.
  said("Ink & Thread can't run in this browser window. Open it in Chrome or Safari, outside private browsing.");
}
