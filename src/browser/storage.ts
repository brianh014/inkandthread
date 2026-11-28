/** Opens the phone build's storage once, in the server worker, before any route runs (ADR: one server, two hosts). */
import sqlite3InitModule, { type SAHPoolUtil } from "@sqlite.org/sqlite-wasm";
import { inPool, touched, attachFiles } from "./fs";
import { errorFields, log } from "../logger";
import { SAVES_LOCK } from "./lock";
import { attachSqlite } from "./sqlite";

const POOL = SAVES_LOCK;
const APP_FILE = "/inkandthread.sqlite";
/** Free file slots kept ahead of need: a Save, its journal and an unfinished copy, several times over. */
const HEADROOM = 16;
/** How long a page waits for the Saves: long enough for the page it replaced, on a reload, to let go of them. */
const LOCK_WAIT_MS = 5000;

/** Another tab or window of the app has the Saves open, and only one can. */
export class OpenElsewhere extends Error {}

/** Holds the lock for as long as this worker lives, as the pool's files are open only to the page holding it. */
function holdLock() {
  return new Promise<void>((held, refused) => {
    navigator.locks
      .request(POOL, { signal: AbortSignal.timeout(LOCK_WAIT_MS) }, () => {
        held();
        return new Promise<never>(() => {});
      })
      .catch(() => refused(new OpenElsewhere("Ink & Thread is open in another tab or window. Close it there to play here.")));
  });
}

export async function openStorage() {
  await holdLock();
  const sqlite3 = await sqlite3InitModule();
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: POOL, initialCapacity: 64 });
  await pool.reserveMinimumCapacity(pool.getFileCount() + HEADROOM);
  // A crash can leave a Save half-written under its unfinished name, never listed; its journal goes with it. A Save's own
  // journal stays, as SQLite needs it to roll back a Turn the crash cut off.
  const unfinished = pool.getFileNames().filter((name) => /\.unfinished(-journal)?$/.test(name));
  for (const name of unfinished) pool.unlink(name);
  const app = new pool.OpfsSAHPoolDb(APP_FILE);
  attachFiles(pool, app);
  attachSqlite(sqlite3, pool, (path) => inPool(path) && touched(path));
  const opened = { files: pool.getFileCount(), capacity: pool.getCapacity(), unfinishedRemoved: unfinished.length, sqlite: sqlite3.version.libVersion };
  return { pool, app, opened };
}

/**
 * Called before each request, never part way through one: the pool can only grow asynchronously, and a Turn that found no
 * free slot for its journal would fail after the reply was paid for.
 */
export async function keepHeadroom(pool: SAHPoolUtil) {
  if (pool.getCapacity() - pool.getFileCount() >= HEADROOM) return;
  try {
    const capacity = await pool.addCapacity(HEADROOM);
    log.info("saves", "Browser storage grown", { files: pool.getFileCount(), capacity });
  } catch (error) {
    // The request goes on, as a full phone must still list, export and delete stories to free space; only a write that needs
    // a new slot fails.
    log.warning("saves", "Browser storage couldn't grow", { files: pool.getFileCount(), capacity: pool.getCapacity(), ...errorFields(error) });
  }
}
