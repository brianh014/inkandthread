import { afterEach, beforeEach, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { startServer } from "../src/rest-api";
import { saveStore } from "../src/save-store";
import { settingsStore } from "../src/settings-store";
import { openingState, type WorldEdit } from "../src/state-applier";
import { journalChange } from "../src/prompt-assembler";
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
      worldRules: ["The city has one boat."],
      plotThreads: ["A thief plans to rob the library at the next high tide."],
      worldBible: [
        { title: "The thief", keywords: ["thief"], content: "The thief is the librarian's own son.", alwaysOn: false },
        { title: "Gulls", keywords: ["gull"], content: "Gulls nest on the dome.", alwaysOn: false },
      ],
    },
  });
const turn = (id: string, input: string) =>
  fetch(new URL(`/saves/${id}/turns`, server.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input }) });
const moved = (...plot_threads: object[]) => JSON.stringify({ plot_threads });

test("at a change of place the world moves on out of sight, and the next Turn reads it moved", async () => {
  const told = play(
    narration(
      "Ash walks to the dock.",
      { op: "add_npc", name: "Ferryman", appearance: "a stooped man in oilskins" },
      { op: "set_scene", location: "The dock", visible_cast: ["Ferryman"] },
    ),
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
  // With the Lore Entries its threads name, so a move keeps who is behind each one true to the world.
  expect(told.prompts[1]!.at(-1)!.content).toContain("the librarian's own son");
  expect(told.prompts[1]!.at(-1)!.content).not.toContain("Gulls nest");
  // And the world rules, so a move keeps to the setting's own facts.
  expect(told.prompts[1]!.at(-1)!.content).toContain("The city has one boat.");
  // And who is with the PC, so a move doesn't retell the scene in play as what they did out of sight.
  expect(told.prompts[1]!.at(-1)!.content).toContain('"visible_cast":["Ferryman"]');
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
  expect(log).toContain("a change misquotes a thread");
});

test("a move is due at a new place, a new day or every few replies, even with no threads, as only a move adds them", () => {
  const before = { ...openingState, plotThreads: ["A thread."], scene: { location: "Here", visibleCast: [] } };
  expect(moveDue(before, before, 1)).toBe(false);
  expect(moveDue(before, { ...before, scene: { location: "There", visibleCast: [] } }, 1)).toBe(true);
  expect(moveDue(before, { ...before, storyTime: { date: "2nd of Thaw", timeOfDay: "dawn", day: 1 } }, 1)).toBe(true);
  expect(moveDue(before, before, MOVE_EVERY)).toBe(true);
  expect(moveDue(before, { ...before, plotThreads: [] }, MOVE_EVERY)).toBe(true);
});

test("the player's Journal edits are still settled after a move, which settles none of them", () => {
  const fact: WorldEdit = { edit: "fact", old: null, new: "Bees sing." };
  const world = { edit: "world" as const, update: { lore_entries: [], removed_lore: [], world_rules: [], plot_threads: [] }, made: 0 };

  expect(journalChange([fact, { ...world, moved: true }])).toContain("Bees sing.");
  expect(journalChange([fact, world])).toBe("");
});

test("a Regenerate drops the move made from the reply it replaces", async () => {
  play(
    narration("Ash walks to the dock.", { op: "set_scene", location: "The dock", visible_cast: [] }),
    moved({ old: "A thief plans to rob the library at the next high tide.", new: "The thief has robbed the library." }),
    narration("Ash stays in the library."),
  );
  const id = createSave();
  expect((await turn(id, "I walk to the dock.")).ok).toBe(true);

  const replaced = store().latestMessageId(id);
  const response = await fetch(new URL(`/saves/${id}/messages/${replaced}/regenerate`, server.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });

  expect(response.ok).toBe(true);
  expect(store().latestState(id).plotThreads).toEqual(["A thief plans to rob the library at the next high tide."]);
});

test("a move adds threads only while fewer than three are open, as an 80-round story's grew to seven that nothing ended", async () => {
  const add = (text: string) => ({ old: null, new: text });
  play(
    narration("Ash walks to the dock.", { op: "set_scene", location: "The dock", visible_cast: [] }),
    moved(add("The ferryman owes the thief."), add("The gulls are omens."), add("The tide is wrong.")),
    narration("Ash watches the barges.", { op: "set_scene", location: "The quay", visible_cast: [] }),
    // Three open now, so a move of adds alone is no move, and isn't asked again.
    moved(add("A fourth.")),
    narration("Ash goes home."),
  );
  const id = createSave();

  const log = await logOf(async () => {
    for (const input of ["I walk to the dock.", "I walk to the quay.", "I go home."]) expect((await turn(id, input)).ok).toBe(true);
  }, "info");

  expect(store().latestState(id).plotThreads).toEqual([
    "A thief plans to rob the library at the next high tide.",
    "The ferryman owes the thief.",
    "The gulls are omens.",
  ]);
  expect(log).toContain('"overflow":1');
  expect(log).not.toContain("World didn't move on");
});

test("a move keeps its usable changes and drops only those that change a thread twice or misquote one", async () => {
  play(
    narration("Ash walks to the dock.", { op: "set_scene", location: "The dock", visible_cast: [] }),
    moved(
      { old: "A thief plans to rob the library at the next high tide.", new: "The thief waits." },
      { old: "A thief plans to rob the library at the next high tide.", new: "The thief strikes." },
      { old: "A thread that isn't there.", new: "x" },
    ),
    narration("Ash watches the barges."),
  );
  const id = createSave();

  const log = await logOf(async () => {
    expect((await turn(id, "I walk to the dock.")).ok).toBe(true);
    expect((await turn(id, "I watch the barges.")).ok).toBe(true);
  }, "info");

  expect(store().latestState(id).plotThreads).toEqual(["The thief waits."]);
  expect(log).toContain('"dropped":{"a change changes a thread twice":1,"a change misquotes a thread":1}');
});

test("a move with no usable change is written again, saying why", async () => {
  const told = play(
    narration("Ash walks to the dock.", { op: "set_scene", location: "The dock", visible_cast: [] }),
    moved({ old: "A thread that isn't there.", new: "x" }),
    moved(),
    narration("Ash watches the barges."),
  );
  const id = createSave();

  expect((await turn(id, "I walk to the dock.")).ok).toBe(true);
  expect((await turn(id, "I watch the barges.")).ok).toBe(true);

  expect(told.prompts.some((prompt) => prompt.at(-1)!.content.includes("a change misquotes a thread"))).toBe(true);
});

test("a move that drops someone its thread named is written again, as a rewrite must keep who is behind it", async () => {
  play(
    narration("Ash walks to the dock.", { op: "set_scene", location: "The dock", visible_cast: [] }),
    moved({ old: "Maren the thief plans to rob the library at the next high tide.", new: "Someone has robbed the library." }),
    moved({ old: "Maren the thief plans to rob the library at the next high tide.", new: "Maren has robbed the library and hides the books on a barge." }),
    narration("Ash watches the barges."),
  );
  const id = store().create({
    worldBrief: "A drowned city",
    pc: { name: "Ash" },
    opening: {
      plotThreads: ["Maren the thief plans to rob the library at the next high tide."],
      worldBible: [{ title: "Maren", keywords: ["Maren", "thief"], content: "The librarian's own son.", alwaysOn: false }],
    },
  });

  expect((await turn(id, "I walk to the dock.")).ok).toBe(true);
  expect((await turn(id, "I watch the barges.")).ok).toBe(true);

  expect(store().latestState(id).plotThreads).toEqual(["Maren has robbed the library and hides the books on a barge."]);
});

test("a move keeps someone when it keeps any one of their names, so a surname alone will do", async () => {
  play(
    narration("Ash walks to the dock.", { op: "set_scene", location: "The dock", visible_cast: [] }),
    moved({ old: "Reverend Amos Thorne plans to land brandy at the next high tide.", new: "Thorne has landed the brandy in the crypt." }),
    narration("Ash watches the barges."),
  );
  const id = store().create({
    worldBrief: "A drowned city",
    pc: { name: "Ash" },
    opening: {
      plotThreads: ["Reverend Amos Thorne plans to land brandy at the next high tide."],
      worldBible: [{ title: "Thorne", keywords: ["Thorne", "Reverend", "Amos", "vicar"], content: "The vicar.", alwaysOn: false }],
    },
  });

  expect((await turn(id, "I walk to the dock.")).ok).toBe(true);
  expect((await turn(id, "I watch the barges.")).ok).toBe(true);

  expect(store().latestState(id).plotThreads).toEqual(["Thorne has landed the brandy in the crypt."]);
});
