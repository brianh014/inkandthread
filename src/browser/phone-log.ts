/**
 * The phone build's log: the lines the desktop writes to `logs/inkandthread.log`, kept in the app file instead, newest
 * last, for the player to save and send with a bug report. Story text is in it only when Story in log is on, as on the desktop.
 */
import type { Database as WasmDb } from "@sqlite.org/sqlite-wasm";

/** About the desktop's 25 MB file at a typical line's length. */
const MOST_LINES = 50_000;
const TRIM_EVERY = 1_000;

let app: WasmDb | undefined;
let sinceTrim = 0;

export function attachLog(appDb: WasmDb) {
  app = appDb;
  app.exec("CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY, line TEXT NOT NULL)");
}

export function keepLogLine(line: string) {
  if (!app) return;
  app.exec({ sql: "INSERT INTO log (line) VALUES (?)", bind: [line] });
  if (++sinceTrim < TRIM_EVERY) return;
  sinceTrim = 0;
  app.exec({ sql: "DELETE FROM log WHERE id <= (SELECT max(id) FROM log) - ?", bind: [MOST_LINES] });
}

export const logText = () => `${(app?.selectValues("SELECT line FROM log ORDER BY id") ?? []).join("\n")}\n`;
