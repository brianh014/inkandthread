/**
 * The phone build's page starts here, before the app (ADR 0006): its server worker, then the service worker that sends
 * the app's requests to it, then the app itself, once the service worker answers for the page.
 */
import { SAVES_LOCK } from "./lock";
import type { Asked } from "./server-worker";

const RELOADED = "inkandthread-reloaded-for-service-worker";

const said = (text: string) => {
  document.body.textContent = text;
};

// Another tab or window, the installed app among them, has the stories open, and only one can. The app would start with no
// server behind it, so the page says so instead, and opens here by itself once that one closes.
async function openElsewhere() {
  const { held = [] } = await navigator.locks.query();
  if (!held.some(({ name }) => name === SAVES_LOCK)) return false;
  said("Ink & Thread is open in another tab or window. Close it there, and it opens here.");
  await navigator.locks.request(SAVES_LOCK, () => {});
  location.reload();
  return true;
}

async function start() {
  // The build puts it at the root, beside sw.js; the app is served from the root of its own origin (ticket 16).
  const server = new Worker("/server-worker.js", { type: "module" });
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
}

try {
  if (!(await openElsewhere())) await start();
} catch {
  // Private browsing and some in-app browsers allow no service worker or Web Locks, and the app has no server without them.
  said("Ink & Thread can't run in this browser window. Open it in Chrome or Safari, outside private browsing.");
}
