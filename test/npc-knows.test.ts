import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { saveStore } from "../src/save-store";
import { narration, scriptedTextProvider, startApp, tempFolder } from "./support";

let folder: ReturnType<typeof tempFolder>;
let savesDir: string;
let app: ReturnType<typeof startApp>;

beforeEach(() => {
  folder = tempFolder();
  savesDir = join(folder.path, "Saves");
});

afterEach(async () => {
  await app?.stop();
  folder.remove();
});

const play = (...replies: string[]) => {
  app = startApp(savesDir, scriptedTextProvider(...replies).textProvider);
};
const store = () => saveStore(savesDir);
const turn = (id: string) => app.post(`/saves/${id}/turns`, { input: "I wait." });

test("a Save from before What an NPC Knows upgrades with no lists, and a Turn then fills one", async () => {
  play(narration("One."));
  const id = store().create({ worldBrief: "A drowned city", pc: { name: "Ash" }, opening: {} });
  await turn(id);
  await app.stop();
  {
    using db = new Database(join(savesDir, `${id}.sqlite`));
    db.run("DELETE FROM snapshot_sections WHERE name = 'npcKnows'; PRAGMA user_version = 25");
  }
  play(narration("Two.", { op: "add_npc", name: "Nadia", appearance: "a tall woman" }, { op: "npc_learns", name: "Nadia", fact: "Saw the fire" }));

  expect(store().snapshot(id, 1).npcKnows).toEqual({});
  expect((await turn(id)).status).toBe(201);

  expect(store().latestState(id).npcKnows).toEqual({ Nadia: ["Saw the fire"] });
});
