/**
 * The part of `node:fs` the server uses, for the phone build, which swaps `node:fs` for this file (ADR: one server, two
 * hosts). SQLite files (Saves, usage) live in the SAH pool; every other file (Settings, world drafts and their pictures),
 * each folder, and each file's last-written time, live in one app SQLite file. A call the server starts making that isn't
 * here fails the phone build, and an option not handled throws, so nothing is ever silently skipped.
 */
import type { Database as WasmDb, SAHPoolUtil } from "@sqlite.org/sqlite-wasm";

let pool: SAHPoolUtil;
let app: WasmDb;

/** Set once at start: the pool, and the app file opened in it. */
export function attachFiles(givenPool: SAHPoolUtil, appDb: WasmDb) {
  pool = givenPool;
  app = appDb;
  app.exec(`CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, bytes BLOB, folder INTEGER NOT NULL DEFAULT 0, mtime REAL NOT NULL);`);
}

/** A file SQLite opens itself, which must live in the pool: a Save, usage, or a Save being written. */
export const inPool = (path: string) => /\.sqlite(\.unfinished)?$/.test(path);

/** Called when a connection that changed a pool file closes, so the Saves list can sort by last played. */
export const touched = (path: string) =>
  void app.exec({ sql: "INSERT INTO files (path, mtime) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime", bind: [path, Date.now()] });

const notFound = (path: string) => Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: "ENOENT", path });
const row = (path: string) =>
  app.selectObject("SELECT bytes, folder, mtime FROM files WHERE path = ?", [path]) as { bytes: Uint8Array | null; folder: number; mtime: number } | undefined;
const inFolder = (path: string) => `${path.replace(/\/$/, "")}/`;
const isFolder = (path: string) =>
  row(path)?.folder === 1 ||
  app.selectValue("SELECT 1 FROM files WHERE path >= ? AND path < ? LIMIT 1", [inFolder(path), `${inFolder(path)}￿`]) === 1 ||
  pool.getFileNames().some((name) => name.startsWith(inFolder(path)));

export function existsSync(path: string) {
  if (inPool(path)) return pool.getFileNames().includes(path);
  const found = row(path);
  return (found !== undefined && (found.bytes !== null || found.folder === 1)) || isFolder(path);
}

export function mkdirSync(path: string, _options?: { recursive?: boolean }) {
  app.exec({ sql: "INSERT INTO files (path, folder, mtime) VALUES (?, 1, ?) ON CONFLICT(path) DO UPDATE SET folder = 1", bind: [path, Date.now()] });
}

export function readdirSync(path: string) {
  const prefix = inFolder(path);
  const names = [
    ...(app.selectValues("SELECT path FROM files WHERE path >= ? AND path < ? AND (bytes IS NOT NULL OR folder = 1)", [prefix, `${prefix}￿`]) as string[]),
    ...pool.getFileNames().filter((name) => name.startsWith(prefix)),
  ];
  return [...new Set(names.map((name) => name.slice(prefix.length).split("/")[0]!))];
}

export function readFileSync(path: string, encoding?: "utf8"): string;
export function readFileSync(path: string): Uint8Array;
export function readFileSync(path: string, encoding?: "utf8") {
  const bytes = inPool(path) ? (pool.getFileNames().includes(path) ? pool.exportFile(path) : undefined) : (row(path)?.bytes ?? undefined);
  if (!bytes) throw notFound(path);
  return encoding ? new TextDecoder().decode(bytes) : bytes;
}

export function writeFileSync(path: string, data: string | Uint8Array) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  if (inPool(path)) {
    pool.importDb(path, bytes);
    touched(path);
  } else
    app.exec({
      sql: "INSERT INTO files (path, bytes, mtime) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET bytes = excluded.bytes, mtime = excluded.mtime",
      bind: [path, bytes, Date.now()],
    });
}

/** The pool can't rename, so a SQLite file is copied and the old one removed: one more copy of a Save in memory, briefly. */
export function renameSync(from: string, to: string) {
  if (inPool(from) !== inPool(to)) throw new Error(`Can't move ${from} to ${to} between the pool and the app file`);
  if (inPool(from)) {
    if (!pool.getFileNames().includes(from)) throw notFound(from);
    pool.importDb(to, pool.exportFile(from));
    pool.unlink(from);
    app.exec({ sql: "DELETE FROM files WHERE path = ?", bind: [from] });
    touched(to);
    return;
  }
  if (!row(from)) throw notFound(from);
  app.transaction(() => {
    app.exec({ sql: "DELETE FROM files WHERE path = ?", bind: [to] });
    app.exec({ sql: "UPDATE files SET path = ?, mtime = ? WHERE path = ?", bind: [to, Date.now(), from] });
  });
}

export function rmSync(path: string, { force = false, recursive = false }: { force?: boolean; recursive?: boolean } = {}) {
  const existed = existsSync(path);
  if (!existed && !force) throw notFound(path);
  if (inPool(path) || path.endsWith("-journal")) pool.unlink(path);
  app.exec({ sql: "DELETE FROM files WHERE path = ?", bind: [path] });
  if (isFolder(path)) {
    if (!recursive) throw Object.assign(new Error(`EISDIR: ${path} is a folder`), { code: "EISDIR" });
    const prefix = inFolder(path);
    for (const name of pool.getFileNames().filter((file) => file.startsWith(prefix))) pool.unlink(name);
    app.exec({ sql: "DELETE FROM files WHERE path >= ? AND path < ?", bind: [prefix, `${prefix}￿`] });
  }
}

export function statSync(path: string) {
  if (!existsSync(path)) throw notFound(path);
  const found = row(path);
  const folder = !inPool(path) && isFolder(path);
  return {
    // A pool file never changed through a connection, such as one only read since import, has no time; the epoch sorts it last.
    mtimeMs: found?.mtime ?? 0,
    // Only when asked, as a pool file's size means reading the whole file.
    get size() {
      return inPool(path) ? pool.exportFile(path).byteLength : (found?.bytes?.byteLength ?? 0);
    },
    isDirectory: () => folder,
    isFile: () => !folder,
  };
}

/** The logger appends only to a log folder, which the phone build never gives it: its lines go to a sink (ticket 10). */
export function appendFileSync(path: string): never {
  throw new Error(`The phone build keeps no log file, so nothing appends to ${path}`);
}

export default { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync };
