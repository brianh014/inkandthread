import { afterEach, beforeEach, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { startServer } from "../src/rest-api";
import { saveStore } from "../src/save-store";
import { settingsStore } from "../src/settings-store";
import { openingState } from "../src/state-applier";
import { MOVE_EVERY, moveDue } from "../src/world-moves-on";
import { logOf, narration, scriptedDice, scriptedImages, scriptedTextProvider, tempFolder } from "./support";

let folder: ReturnType<typeof tempFolder>;
let savesDir: string;
let server: ReturnType<typeof startServer>;

beforeEach(() => {
  folder = tempFolder();
  savesDir = join(folder.path, "Saves");
});
afterEach(async () => {
  await server.stop(true);
  folder.remove();
});

function play(...replies: (string | Error)[]) {
  const settings = settingsStore(join(dirname(savesDir), "settings.json"));
  settings.update({ textModel: "narrator/model" });
  const told = scriptedTextProvider(...replies);
  server = startServer({
    savesDir,
    settings,
    textProvider: told.textProvider,
    imageAdapter: scriptedImages().imageAdapter,
    dice: scriptedDice(),
    nearMissMargin: 2,
    port: 0,
    moveWorld: true,
    writePicture: async (_ask, _style, fallback) => fallback,
    reviewPicture: async (description) => description,
  });
  return told;
}

const store = () => saveStore(savesDir);
const createSave = () =>
  store().create({
    worldBrief: "A drowned city",
    pc: { name: "Ash" },
    opening: {
      inventory: { wearing: [], carrying: [] },
      scene: { location: "The library", visibleCast: [] },
      summary: "",
      plotThreads: ["A thief plans to rob the library at the next high tide."],
    },
  });
const turn = (id: string, input: string) =>
  fetch(new URL(`/saves/${id}/turns`, server.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input }) });
const moved = (...plot_threads: object[]) => JSON.stringify({ plot_threads });

test("at a change of place the world moves on out of sight, and the next Turn reads it moved", async () => {
  const told = play(
    narration("Ash walks to the dock.", { op: "set_scene", location: "The dock", visible_cast: [] }),
    moved({ old: "A thief plans to rob the library at the next high tide.", new: "The thief has robbed the library and hides the books on a barge." }),
    narration("Ash watches the barges."),
  );
  const id = createSave();

  const log = await logOf(async () => {
    expect((await turn(id, "I walk to the dock.")).ok).toBe(true);
    expect((await turn(id, "I watch the barges.")).ok).toBe(true);
  }, "info");

  // The move was asked between the Turns, with the threads and the story so far.
  expect(told.prompts.length).toBe(3);
  expect(told.prompts[1]!.at(-1)!.content).toContain("rob the library");
  expect(told.prompts[2]!.map(({ content }) => content).join("\n")).toContain("hides the books on a barge");
  expect(store().latestState(id).plotThreads).toEqual(["The thief has robbed the library and hides the books on a barge."]);
  expect(log).toContain('"threads":1,"added":0,"removed":0');
  expect(log).not.toContain("barge");
});

test("a move that misquotes a thread, or fails, leaves the world as it was and the next Turn plays", async () => {
  play(
    narration("Ash walks to the dock.", { op: "set_scene", location: "The dock", visible_cast: [] }),
    moved({ old: "No such thread.", new: "Something else." }),
    moved({ old: "No such thread.", new: "Something else." }),
    moved({ old: "No such thread.", new: "Something else." }),
    narration("Ash watches the barges."),
  );
  const id = createSave();

  const log = await logOf(async () => {
    expect((await turn(id, "I walk to the dock.")).ok).toBe(true);
    expect((await turn(id, "I watch the barges.")).ok).toBe(true);
  }, "info");

  expect(store().latestState(id).plotThreads).toEqual(["A thief plans to rob the library at the next high tide."]);
  expect(log).toContain("World didn't move on");
});

test("a move is due at a new place, a new day or every few replies, and never with no threads", () => {
  const before = { ...openingState, plotThreads: ["A thread."], scene: { location: "Here", visibleCast: [] } };
  expect(moveDue(before, before, 1)).toBe(false);
  expect(moveDue(before, { ...before, scene: { location: "There", visibleCast: [] } }, 1)).toBe(true);
  expect(moveDue(before, { ...before, storyTime: { date: "2nd of Thaw", timeOfDay: "dawn", day: 1 } }, 1)).toBe(true);
  expect(moveDue(before, before, MOVE_EVERY)).toBe(true);
  expect(moveDue(before, { ...before, plotThreads: [] }, MOVE_EVERY)).toBe(false);
});
