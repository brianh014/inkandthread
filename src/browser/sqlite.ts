/**
 * The part of `bun:sqlite` the server uses, over SQLite's WASM build, for the phone build (ADR: one server, two hosts). The
 * phone bundle swaps `bun:sqlite` for this file, so `save-store` and `usage-store` run unchanged. Files open in the SAH pool,
 * which is synchronous, as `bun:sqlite` is. Only what the server calls is here, and it must behave as Bun's does.
 */
import type { Database as WasmDb, PreparedStatement, SAHPoolUtil, SqlValue, Sqlite3Static } from "@sqlite.org/sqlite-wasm";

let sqlite3: Sqlite3Static;
let pool: SAHPoolUtil;
let written: (path: string) => void = () => {};

/** Set once at start, before any Database opens. `onWritten` hears of each pool file a connection changed, when it closes. */
export function attachSqlite(given: Sqlite3Static, givenPool: SAHPoolUtil, onWritten: (path: string) => void) {
  sqlite3 = given;
  pool = givenPool;
  written = onWritten;
}

export type SQLQueryBindings = SqlValue | boolean | undefined;
type Row = Record<string, SqlValue>;

const bindsOf = (args: unknown[]) => (args.length === 1 && Array.isArray(args[0]) ? (args[0] as unknown[]) : args);

// Bun gives a lossy number past 2^53, never a bigint, so the server never sees one.
const plain = (value: SqlValue) => (typeof value === "bigint" ? Number(value) : value);
const plainRow = (row: Row) => {
  for (const key in row) row[key] = plain(row[key]!);
  return row;
};

class Statement {
  constructor(
    private readonly db: Database,
    private readonly sql: string,
  ) {}

  private each<T>(args: unknown[], read: (stmt: PreparedStatement) => T, first = false): T[] {
    const stmt = this.db.prepared(this.sql);
    try {
      const binds = bindsOf(args);
      // Bun's strict mode refuses a statement short of values rather than binding NULL for the rest.
      if (binds.length !== stmt.parameterCount) throw new RangeError(`SQLite query expected ${stmt.parameterCount} values, received ${binds.length}`);
      if (binds.length) stmt.bind(binds.map((value) => (value === undefined ? null : typeof value === "boolean" ? Number(value) : value)) as SqlValue[]);
      const rows: T[] = [];
      while (stmt.step()) {
        rows.push(read(stmt));
        if (first) break;
      }
      return rows;
    } finally {
      stmt.reset(true);
    }
  }

  get columnNames() {
    return this.db.prepared(this.sql).getColumnNames();
  }
  get(...args: unknown[]) {
    return this.each(args, (stmt) => plainRow(stmt.get({}) as Row), true)[0] ?? null;
  }
  all(...args: unknown[]) {
    return this.each(args, (stmt) => plainRow(stmt.get({}) as Row));
  }
  values(...args: unknown[]) {
    return this.each(args, (stmt) => (stmt.get([]) as SqlValue[]).map(plain));
  }
  run(...args: unknown[]) {
    this.each(args, () => undefined);
    return this.db.changes();
  }
}

export class Database {
  readonly raw: WasmDb;
  private readonly path: string | undefined;
  private readonly statements = new Map<string, PreparedStatement>();
  private depth = 0;

  constructor(path?: string, _options?: { create?: boolean; strict?: boolean; readonly?: boolean }) {
    this.path = path && path !== ":memory:" ? path : undefined;
    this.raw = this.path ? new pool.OpfsSAHPoolDb(this.path) : new sqlite3.oo1.DB(":memory:", "c");
  }

  /** As Bun's: a database in memory holding `bytes`, read-only if asked. */
  static deserialize(bytes: Uint8Array, readonly = false) {
    const db = new Database(":memory:");
    const { capi, wasm } = sqlite3;
    const at = wasm.allocFromTypedArray(bytes);
    const flags = capi.SQLITE_DESERIALIZE_FREEONCLOSE | (readonly ? capi.SQLITE_DESERIALIZE_READONLY : capi.SQLITE_DESERIALIZE_RESIZEABLE);
    db.raw.checkRc(capi.sqlite3_deserialize(db.raw, "main", at, bytes.byteLength, bytes.byteLength, flags));
    return db;
  }

  /** One statement per SQL text for the connection's life, as preparing again for each row made import six times slower. */
  prepared(sql: string) {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.raw.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  changes() {
    const { capi } = sqlite3;
    return { changes: capi.sqlite3_changes(this.raw), lastInsertRowid: Number(capi.sqlite3_last_insert_rowid(this.raw)) };
  }

  serialize(): Uint8Array {
    return sqlite3.capi.sqlite3_js_db_export(this.raw);
  }
  query(sql: string) {
    return new Statement(this, sql);
  }
  prepare(sql: string) {
    return new Statement(this, sql);
  }
  /** As Bun's: several statements when given no values. */
  run(sql: string, binds?: unknown[]) {
    if (binds?.length) this.query(sql).run(binds);
    else this.raw.exec(sql);
    return this.changes();
  }

  /** As Bun's: a function that runs `fn` in a transaction, or a savepoint inside one. */
  transaction<A extends unknown[], R>(fn: (...args: A) => R) {
    return (...args: A): R => {
      const savepoint = `inkandthread_${this.depth}`;
      this.raw.exec(this.depth === 0 ? "BEGIN" : `SAVEPOINT ${savepoint}`);
      this.depth++;
      try {
        const result = fn(...args);
        this.depth--;
        this.raw.exec(this.depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        this.depth--;
        // SQLite rolls back on its own after some errors, such as a full disk, and rolling back again would hide the real one.
        if (!sqlite3.capi.sqlite3_get_autocommit(this.raw)) this.raw.exec(this.depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        throw error;
      }
    };
  }

  close() {
    if (!this.raw.isOpen()) return;
    for (const stmt of this.statements.values()) stmt.finalize();
    this.statements.clear();
    const changed = this.path && sqlite3.capi.sqlite3_total_changes(this.raw) > 0;
    this.raw.close();
    if (changed) written(this.path!);
  }
  [Symbol.dispose]() {
    this.close();
  }
}

// `using` looks for Symbol.dispose, or this stand-in for it where an engine has none.
const disposeKey = Symbol.for("Symbol.dispose");
if ((Symbol.dispose as symbol | undefined) !== disposeKey) Object.defineProperty(Database.prototype, disposeKey, { value: Database.prototype.close });
