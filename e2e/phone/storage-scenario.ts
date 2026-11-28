/**
 * One run through the Saves, the same on Bun's SQLite and in a browser on the phone build's stand-ins, so the two can be
 * compared (`phone-storage.spec.ts`). Ids and times differ between runs, so they are numbered in order seen and dropped.
 */
import { Database } from "bun:sqlite";
import type { saveStore } from "../../src/save-store";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const picture = (seed: number) => new Uint8Array([...PNG, ...Array.from({ length: 2000 }, (_, i) => (i * 31 + seed) % 256)]);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TIMES = /^(createdAt|created_at|updatedAt|mtimeMs|at|storyTime)$/;

/** Ids numbered in the order they are first seen, times dropped, and bytes kept as their length and a sum. */
function normal(value: unknown) {
  const ids = new Map<string, string>();
  const walk = (item: unknown): unknown => {
    if (typeof item === "string")
      return item.replace(UUID, (id) => {
        if (!ids.has(id)) ids.set(id, `id${ids.size + 1}`);
        return ids.get(id)!;
      });
    if (item instanceof Uint8Array) return `bytes ${item.byteLength}, sum ${item.reduce((sum, byte) => (sum + byte) % 65521, 0)}`;
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .filter(([key]) => !TIMES.test(key))
          .map(([key, inner]) => [key, walk(inner)]),
      );
    return item;
  };
  return walk(value);
}

const threw = (fn: () => unknown) => {
  try {
    fn();
    return "no";
  } catch {
    return "threw";
  }
};

/** Where Bun's SQLite and the stand-in could differ: binds, missing rows, big numbers, savepoints, read-only copies. */
function sqliteChecks() {
  using db = new Database(":memory:", { strict: true });
  db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER, b BLOB, s TEXT)");
  const insert = db.query("INSERT INTO t (n, b, s) VALUES (?, ?, ?)");
  const first = insert.run(1, new Uint8Array([1, 2, 3]), null);
  const checks: Record<string, unknown> = { first, missingBind: threw(() => insert.run(2)), none: db.query("SELECT * FROM t WHERE id = 99").get() };
  checks.row = db.query("SELECT * FROM t").get();
  checks.values = db.query("SELECT n, s FROM t").values();
  checks.big = db.query("SELECT 9007199254740993 AS x, 2.5 AS y").get();
  db.query("INSERT INTO t (n, b, s) VALUES (?, ?, ?)").run(true, null, null);
  db.transaction(() => {
    db.run("INSERT INTO t (n) VALUES (10)");
    checks.inner = threw(() =>
      db.transaction(() => {
        db.run("INSERT INTO t (n) VALUES (11)");
        throw new Error("inner");
      })(),
    );
  })();
  checks.afterNested = db.query("SELECT n, s FROM t ORDER BY id").values();
  checks.columnNames = db.query("SELECT n AS count, s FROM t").columnNames;
  using copy = Database.deserialize(db.serialize(), true);
  checks.readonlyWrite = threw(() => copy.run("INSERT INTO t (n) VALUES (1)"));
  checks.copyRows = copy.query("SELECT count(*) AS rows FROM t").get();
  return checks;
}

export function storageScenario(store: ReturnType<typeof saveStore>) {
  const steps: Record<string, unknown> = { sqlite: sqliteChecks() };
  const id = store.create({
    worldBrief: "A harbour city of fog and bells.",
    pc: { name: "Ada" },
    title: "The Bells",
    importantCharacters: [{ name: "Tobin", description: "A ferryman who owes a debt.", onCover: true }],
    opening: { looseEnds: ["Who rang the bell at midnight?"] },
  });
  const narrated: number[] = [];
  for (const [i, move] of ["I look around the quay.", "I ask the ferryman his name.", "I pay him in copper."].entries()) {
    const [, narrator] = store.commitTurn(
      id,
      store.latestMessageId(id),
      move,
      `The fog answers move ${i}.`,
      undefined,
      (state) => ({ ...state, inventory: { ...state.inventory, carrying: [...state.inventory.carrying, `token ${i}`] } }),
      [`Choice ${i}a`, `Choice ${i}b`, `Choice ${i}c`],
    );
    narrated.push(narrator!.id);
    store.addSceneImage(id, narrator!.id, `The quay, ${i}`, picture(i), `prompt ${i}`, ["Ada"]);
  }
  steps.afterTurns = { messages: store.messages(id), state: store.latestState(id), gallery: store.gallery(id), latestChoices: store.latestChoices(id) };

  const copy = store.duplicate(id, narrated[1]);
  steps.copy = { copy, messages: store.messages(typeof copy === "string" ? copy : (copy as { id: string }).id) };

  steps.revert = store.revert(id, narrated[0]!);
  steps.afterRevert = { messages: store.messages(id), state: store.latestState(id), gallery: store.gallery(id) };

  // A stale Turn, based on a Message since reverted away, is refused and changes nothing.
  try {
    store.commitTurn(id, narrated[2]!, "Too late.", "Never written.", undefined, (state) => state);
    steps.stale = "committed";
  } catch (error) {
    steps.stale = (error as Error).constructor.name;
  }

  const bytes = store.export(id);
  const imported = store.import(bytes);
  steps.imported = {
    messages: store.messages(imported),
    state: store.latestState(imported),
    read: store.read(imported),
    image: store.sceneImage(imported, narrated[0]!),
  };

  store.delete(id);
  steps.list = store.list().map(({ updatedAt: _, ...save }) => save);
  return normal(steps);
}
