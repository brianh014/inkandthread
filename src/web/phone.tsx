/**
 * What only the phone app needs (ADR 0006), whose server runs in this page: the screen kept on while the AI writes, and
 * the Menu's notes on installing it and keeping a copy of the stories, which live only on the device.
 */
import { useEffect, useState } from "react";
import { inPageServer, listSaves } from "./api";

const INSTALL_SEEN = "inkandthread-install-note-seen";
const BACKED_UP = "inkandthread-backed-up-at";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const stored = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {}
};

/** Called on Export, so the reminder waits another week. */
export const backedUp = () => store(BACKED_UP, String(Date.now()));

/**
 * Keeps the screen on while `active`, as a phone that locks mid-Turn pauses the app, and with it the Turn. A browser
 * drops the lock when the page is hidden, so it is taken again on return. Only in the phone app.
 */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !inPageServer() || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | undefined;
    let done = false;
    const take = () => {
      if (document.visibilityState !== "visible") return;
      navigator.wakeLock.request("screen").then(
        (taken) => {
          if (done) void taken.release();
          else lock = taken;
        },
        // Refused, as on low battery: the Turn goes on, only the screen may lock.
        () => {},
      );
    };
    take();
    document.addEventListener("visibilitychange", take);
    return () => {
      done = true;
      document.removeEventListener("visibilitychange", take);
      void lock?.release();
    };
  }, [active]);
}

const CHECK_EVERY_MS = 60 * 60_000;

/** A new build of the phone app, downloaded and waiting for a reload, or undefined. Checks every hour. */
export function usePhoneUpdate() {
  const [waiting, setWaiting] = useState<ServiceWorker>();
  useEffect(() => {
    if (!inPageServer()) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    let gone = false;
    void navigator.serviceWorker.getRegistration().then((registration) => {
      if (!registration || gone) return;
      const look = () => setWaiting(registration.waiting ?? undefined);
      look();
      // One already installing when the page first looks fired its updatefound before anyone listened.
      registration.installing?.addEventListener("statechange", look);
      registration.addEventListener("updatefound", () => registration.installing?.addEventListener("statechange", look));
      timer = setInterval(() => void registration.update().catch(() => {}), CHECK_EVERY_MS);
    });
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, []);
  return waiting;
}

/** Hands over to the waiting build and reloads as it; a Turn cut off by the reload gives its move back (Play). */
export function reloadToUpdate(waiting: ServiceWorker) {
  navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true });
  waiting.postMessage("take-over");
}

const installed = () => matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

/** The Menu's notes in the phone app: install it before a first story, and export now and then. */
export function PhoneNotes() {
  const [install, setInstall] = useState(() => inPageServer() && !installed() && !stored(INSTALL_SEEN));
  const [backup, setBackup] = useState(false);

  useEffect(() => {
    if (!inPageServer()) return;
    listSaves().then(
      (saves) => {
        if (saves.length === 0) return;
        const since = Number(stored(BACKED_UP));
        // The week starts with the first story seen, not at once.
        if (!since) backedUp();
        else if (Date.now() - since > WEEK_MS) setBackup(true);
      },
      () => {},
    );
  }, []);

  return (
    <>
      {install && (
        <div className="notice dismissable">
          <p>
            <b>Add Ink & Thread to your Home Screen</b> before you start. A browser may clear a website's stories after a while, but keeps an installed app's.
            In Safari, tap Share, then Add to Home Screen. In Chrome, open the menu, then Install app. In Firefox, open the menu, then Add to Home screen.
          </p>
          <button
            type="button"
            className="quiet"
            aria-label="Close the note on installing"
            onClick={() => {
              store(INSTALL_SEEN, "1");
              setInstall(false);
            }}
          >
            ×
          </button>
        </div>
      )}
      {backup && (
        <div className="notice dismissable">
          <p>
            Your stories live only on this device. <a href="#/load">Export them</a> now and then to keep a copy.
          </p>
          <button
            type="button"
            className="quiet"
            aria-label="Remind me next week"
            onClick={() => {
              backedUp();
              setBackup(false);
            }}
          >
            ×
          </button>
        </div>
      )}
    </>
  );
}
