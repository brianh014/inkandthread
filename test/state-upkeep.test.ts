import { afterEach, beforeEach, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { startServer } from "../src/rest-api";
import { slowReviewer, UPKEEP_LIMIT } from "../src/state-upkeep";
import { saveStore } from "../src/save-store";
import { settingsStore } from "../src/settings-store";
import { logOf, narration, scriptedDice, scriptedImages, scriptedTextProvider, tempFolder } from "./support";

let folder: ReturnType<typeof tempFolder>;
let savesDir: string;
let server: ReturnType<typeof startServer>;

beforeEach(() => {
  // Shared by every Save, so one test's time-out would lower another's thinking.
  slowReviewer.steps = 0;
  slowReviewer.quick = 0;
  folder = tempFolder();
  savesDir = join(folder.path, "Saves");
});
afterEach(async () => {
  await server.stop(true);
  folder.remove();
});

/** A server whose Narrator and reviewer each follow a script. The reviewer is the Narrator's model, as by default. */
function play(narrator: (string | Error)[], reviewer: (string | Error)[], stalled = false) {
  const settings = settingsStore(join(dirname(savesDir), "settings.json"));
  settings.update({ textModel: "narrator/model" });
  const told = scriptedTextProvider(...narrator);
  const upkeep = scriptedTextProvider(...reviewer);
  server = startServer({
    savesDir,
    settings,
    textProvider: told.textProvider,
    // One that answers only when stopped, like a reviewer stuck retrying.
    reviewProvider: stalled
      ? (_prompt, { signal }) => new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)))
      : upkeep.textProvider,
    imageAdapter: scriptedImages().imageAdapter,
    dice: scriptedDice(),
    nearMissMargin: 2,
    port: 0,
    writePicture: async (_ask, _style, fallback) => fallback,
    reviewPicture: async (description) => description,
  });
  return { told, upkeep };
}

const store = () => saveStore(savesDir);
const createSave = () =>
  store().create({
    worldBrief: "A drowned city",
    pc: { name: "Ash" },
    opening: { inventory: { wearing: ["a coat"], carrying: [] }, scene: { location: "The library", visibleCast: [] }, summary: "It began to rain." },
  });
const turn = (id: string, input = "I walk home and hang up my coat.") =>
  fetch(new URL(`/saves/${id}/turns`, server.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input }) });
const upkept = (...state_operations: object[]) => JSON.stringify({ state_operations });

test("State Upkeep records what the reply showed and the Narrator missed, after the Narrator's own operations", async () => {
  const { upkeep } = play(
    [narration("Ash walks home through the rain and hangs the coat by the door.", { op: "add_item", slot: "carrying", item: "a key" })],
    [upkept({ op: "set_scene", location: "Ash's flat", visible_cast: [] }, { op: "remove_item", item: "a coat" })],
  );
  const id = createSave();

  const log = await logOf(async () => expect((await turn(id)).ok).toBe(true), "info");

  const state = store().latestState(id);
  expect(state.scene.location).toBe("Ash's flat");
  expect(state.inventory).toEqual({ wearing: [], carrying: ["a key"] });
  // It sees the state after the Narrator's operations, with the move and the reply, and of the hidden world only the Plot Threads.
  const sent = JSON.parse(upkeep.prompts[0]!.at(-1)!.content);
  // No reply came before the first, so there is no previous one to agree with.
  expect(sent).toMatchObject({ state: { inventory: { carrying: ["a key"] } }, previous_reply: "", player_move: "I walk home and hang up my coat." });
  expect(sent.reply).toContain("hangs the coat");
  expect(Object.keys(sent.state)).not.toContain("plot_threads");
  expect(Object.keys(sent.state)).not.toContain("worldBible");
  expect(log).toContain('"operations":["set_scene","remove_item"]');
  expect(log).toContain('"upkeepRefused":0');
  expect(log).not.toContain("Ash's flat");
});

test("a failed State Upkeep keeps the Narrator's state, and the Turn is saved", async () => {
  play([narration("Ash walks home.", { op: "add_item", slot: "carrying", item: "a key" })], [new Error("down")]);
  const id = createSave();

  const log = await logOf(async () => expect((await turn(id)).ok).toBe(true), "info");

  expect(store().latestState(id).inventory.carrying).toEqual(["a key"]);
  expect(store().latestState(id).scene.location).toBe("The library");
  expect(log).toContain("State Upkeep skipped");
});

test("State Upkeep that runs past its time limit keeps the Narrator's state, and the Turn is saved", async () => {
  const limit = UPKEEP_LIMIT.ms;
  UPKEEP_LIMIT.ms = 20;
  try {
    play([narration("Ash walks home.", { op: "add_item", slot: "carrying", item: "a key" })], [], true);
    const id = createSave();

    const log = await logOf(async () => expect((await turn(id)).ok).toBe(true), "info");

    expect(store().latestState(id).inventory.carrying).toEqual(["a key"]);
    expect(log).toContain("State Upkeep skipped");
    // So the next review thinks a level less, rather than being cut off again.
    expect(log).toContain("Review thinking lowered");
    expect(slowReviewer.steps).toBe(1);
  } finally {
    UPKEEP_LIMIT.ms = limit;
  }
});

test("an operation of State Upkeep's that the state refuses is dropped, and the rest still apply", async () => {
  play([narration("Ash walks home.")], [upkept({ op: "remove_item", item: "a hat" }, { op: "set_scene", location: "Ash's flat", visible_cast: [] })]);
  const id = createSave();

  const log = await logOf(async () => expect((await turn(id)).ok).toBe(true), "info");

  expect(store().latestState(id).scene.location).toBe("Ash's flat");
  expect(log).toContain('"upkeepRefused":1');
});

test("State Upkeep doesn't move time in a Turn where the Narrator did, as it moved it a second time", async () => {
  const time = (days_passed: number, date: string, time_of_day: string) => ({ op: "set_story_time", days_passed, date, time_of_day });
  const { upkeep } = play(
    [narration("Ash wakes at dawn.", time(0, "1st of Thaw", "dusk")), narration("Ash wakes at dawn.", time(1, "2nd of Thaw", "dawn"))],
    [upkept(), upkept(time(4, "3rd of Thaw", "morning"), { op: "set_scene", location: "Ash's flat", visible_cast: [] })],
  );
  const id = createSave();
  await turn(id);

  const log = await logOf(async () => expect((await turn(id)).ok).toBe(true), "info");

  expect(store().latestState(id).storyTime).toEqual({ day: 2, date: "2nd of Thaw", timeOfDay: "dawn" });
  expect(store().latestState(id).scene.location).toBe("Ash's flat");
  // Not even offered, so its wrong time can't creep into the facts it rewrites; one given anyway is dropped.
  expect(upkeep.prompts.map((prompt) => prompt[0]!.content.includes("set_story_time"))).toEqual([false, false]);
  expect(log).toContain('"operations":["set_scene"],"dropped":1');
});

test("State Upkeep is sent the Loose Ends and resolves one the reply settled, as long stories kept a dozen stale", async () => {
  const { upkeep } = play(
    [narration("Ash finds the key under the mat.", { op: "add_loose_end", loose_end: "Find the key to the boathouse" })],
    [upkept({ op: "resolve_loose_end", loose_end: "Find the key to the boathouse" })],
  );
  const id = createSave();

  expect((await turn(id)).ok).toBe(true);

  expect(JSON.parse(upkeep.prompts[0]!.at(-1)!.content).state.loose_ends).toEqual(["Find the key to the boathouse"]);
  expect(upkeep.prompts[0]![0]!.content).toContain("resolve_loose_end");
  expect(store().latestState(id).looseEnds).toEqual([]);
});

test("State Upkeep may move time in a Turn where the Narrator didn't", async () => {
  const { upkeep } = play([narration("Ash waits until dark.")], [upkept({ op: "set_story_time", days_passed: 0, date: "1st of Thaw", time_of_day: "night" })]);
  const id = createSave();

  expect((await turn(id)).ok).toBe(true);

  expect(upkeep.prompts[0]![0]!.content).toContain("set_story_time");
  expect(store().latestState(id).storyTime).toEqual({ day: 1, date: "1st of Thaw", timeOfDay: "night" });
});

test("an operation State Upkeep may not give, or a broken one, is dropped and the rest kept, with no second call", async () => {
  const { upkeep } = play(
    [narration("Ash walks home.")],
    [
      upkept(
        { op: "add_plot_thread", thread: "The tide rises." },
        { op: "set_scene", location: "x", visible_cast: [] },
        { op: "remove_item", item: "" },
        { op: "add_item", slot: "carrying", item: "a key" },
      ),
    ],
  );
  const id = createSave();

  const log = await logOf(async () => expect((await turn(id)).ok).toBe(true), "info");

  const state = store().latestState(id);
  expect(state.plotThreads).toEqual([]);
  // A place name with no word in it would show as the Journal's location.
  expect(state.scene.location).toBe("The library");
  expect(state.inventory.carrying).toEqual(["a key"]);
  expect(upkeep.prompts.length).toBe(1);
  expect(log).toContain('"operations":["add_item"],"dropped":3');
});

test("State Upkeep never changes a Plot Thread, which is World Moves On's", async () => {
  play(
    [narration("Ash finds the thief at the dock and the thief confesses.")],
    [
      upkept(
        { op: "update_plot_thread", thread: "A thief steals from the library.", replacement: "The exposed thief flees by boat." },
        { op: "resolve_plot_thread", thread: "The tide rises." },
      ),
    ],
  );
  const id = store().create({
    worldBrief: "A drowned city",
    pc: { name: "Ash" },
    opening: {
      inventory: { wearing: [], carrying: [] },
      scene: { location: "The dock", visibleCast: [] },
      summary: "",
      plotThreads: ["A thief steals from the library.", "The tide rises."],
    },
  });

  const log = await logOf(async () => expect((await turn(id)).ok).toBe(true), "info");

  expect(store().latestState(id).plotThreads).toEqual(["A thief steals from the library.", "The tide rises."]);
  expect(log).toContain('"operations":[],"dropped":2');
  expect(log).not.toContain("thief");
});

test("State Upkeep is sent the reply before, so a description two replies agree is out of date can be brought up to date", async () => {
  const { upkeep } = play([narration("Ash walks home in the rain."), narration("Ash shakes the rain off.")], [upkept(), upkept()]);
  const id = createSave();
  await turn(id);

  await turn(id, "I shake off the rain.");

  expect(JSON.parse(upkeep.prompts[1]!.at(-1)!.content).previous_reply).toBe("Ash walks home in the rain.");
});
