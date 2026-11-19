import { afterEach, beforeEach, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { startServer } from "../src/rest-api";
import { saveStore } from "../src/save-store";
import { settingsStore } from "../src/settings-store";
import { openingState, type WorldEdit } from "../src/state-applier";
import { journalChange } from "../src/prompt-assembler";
import { MOVE_EVERY, moveDue, threadGuards, turnThreadChanges } from "../src/world-moves-on";
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
// A new day, which makes a move due.
const nextDay = (date = "2nd of Thaw") => ({ op: "set_story_time", days_passed: 1, date, time_of_day: "dawn" });

test("on a new day the world moves on out of sight, and the next Turn reads it moved", async () => {
  const told = play(
    narration(
      "Ash walks to the dock.",
      { op: "add_npc", name: "Ferryman", appearance: "a stooped man in oilskins" },
      { op: "set_scene", location: "The dock", visible_cast: ["Ferryman"] },
      nextDay(),
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

test("a move reads the Lore Entries the story names too, not only its threads', so a thread it adds keeps to the world", async () => {
  const told = play(
    narration(
      "Ash catches the thief where a gull nests on the dome.",
      { op: "resolve_plot_thread", thread: "A thief plans to rob the library at the next high tide." },
      { op: "set_scene", location: "The dome", visible_cast: [] },
      nextDay(),
    ),
    moved(),
    narration("Ash looks out over the city."),
  );
  const id = createSave();

  expect((await turn(id, "I climb to the dome.")).ok).toBe(true);
  // The next Turn waits for the move.
  expect((await turn(id, "I look out.")).ok).toBe(true);

  expect(told.prompts[1]!.at(-1)!.content).toContain("Gulls nest");
});

test("a Turn's resolve only asks the next move to close the thread, which the move removes or keeps", async () => {
  const THIEF = "A thief plans to rob the library at the next high tide.";
  const told = play(
    narration(
      "Ash catches the thief at the dock.",
      { op: "resolve_plot_thread", thread: THIEF },
      { op: "set_scene", location: "The dock", visible_cast: [] },
      nextDay(),
    ),
    moved({ old: THIEF, new: null }),
    narration("Ash looks out over the water."),
  );
  const id = createSave();

  const log = await logOf(async () => {
    expect((await turn(id, "I catch him.")).ok).toBe(true);
    // The next Turn waits for the move.
    expect((await turn(id, "I look out.")).ok).toBe(true);
  }, "info");

  // Still open when the move was asked, which was told the Turn asked to close it.
  const asked = JSON.parse(told.prompts[1]!.at(-1)!.content);
  expect(asked.plot_threads).toEqual([THIEF]);
  expect(asked.asked_to_close).toEqual([THIEF]);
  expect(store().latestState(id).plotThreads).toEqual([]);
  expect(log).toContain('"closeAsked":1');
  expect(log).toContain('"asked":1,"closed":1');
});

test("a close ask follows its thread through a later rewrite, and a Turn logs only the asks that matched a thread", async () => {
  const THIEF = "A thief plans to rob the library at the next high tide.";
  const REWRITTEN = "The thief waits at the dock to rob the library at the next high tide.";
  const told = play(
    narration("Ash hears of a ghost.", { op: "resolve_plot_thread", thread: "A ghost haunts the dome." }),
    narration("Ash corners the thief.", { op: "resolve_plot_thread", thread: THIEF }),
    narration("The thief slips away.", { op: "update_plot_thread", thread: THIEF, replacement: REWRITTEN }, nextDay()),
    moved(),
    narration("Ash looks out."),
  );
  const id = createSave();

  const log = await logOf(async () => {
    for (const input of ["I listen.", "I grab him.", "I chase him.", "I look out."]) expect((await turn(id, input)).ok).toBe(true);
  }, "info");

  expect(JSON.parse(told.prompts[3]!.at(-1)!.content).asked_to_close).toEqual([REWRITTEN]);
  expect(log).toContain('"closeAsked":0');
  expect(log).toContain('"closeAsked":1');
});

test("a Turn's thread rewrite that drops a name or retells the scene, or a resolve of a thread whose people the reply never names or the Turn also rewrites, is dropped", () => {
  const state = {
    ...openingState,
    npcs: [
      { name: "Grout", appearance: "" },
      { name: "Kit", appearance: "" },
    ],
    scene: { location: "The shed", visibleCast: ["Kit"] },
    plotThreads: ["Grout hides the ledger.", "Kit fears Grout.", "Kit owes rent."],
  };
  const operations = [
    { op: "update_plot_thread", thread: "Grout hides the ledger.", replacement: "Someone hides the ledger." },
    { op: "update_plot_thread", thread: "Kit fears Grout.", replacement: "Kit waits with Ash at the shed door, fearing Grout." },
    { op: "resolve_plot_thread", thread: "Grout hides the ledger." },
    { op: "resolve_plot_thread", thread: "Kit owes rent." },
    { op: "update_plot_thread", thread: "Kit owes rent.", replacement: "Kit owes two weeks' rent." },
  ] as Parameters<typeof turnThreadChanges>[0];

  const { kept, dropped } = turnThreadChanges(operations, state, "Ash", "Kit counts his coins.");

  expect(kept).toEqual(operations.slice(4));
  expect(dropped).toEqual({
    "a rewrite drops someone the thread named": 1,
    "a rewrite retells the scene in play": 1,
    "a resolve of a thread whose people the reply never names": 1,
    "a resolve of a thread the Turn also rewrites": 1,
  });
});

test("a rewrite keeps a many-word name or Lore keyword when it keeps the word that tells it apart, but not a title alone", () => {
  const state = {
    ...openingState,
    worldBible: [
      { title: "The mill", keywords: ["mill", "Orrin's mill"], content: "", alwaysOn: false },
      { title: "The judge", keywords: ["Mr Pell", "judge"], content: "", alwaysOn: false },
    ],
  };
  const { keepsNames } = threadGuards(state, "Ash");
  const old = "Mr Pell means to burn Orrin's mill.";

  expect(keepsNames({ old, new: "Pell means to burn Orrin's place before the hearing." })).toBe(true);
  expect(keepsNames({ old, new: "Mr Pell means to burn the mill tonight." })).toBe(false);
  expect(keepsNames({ old, new: "Mr Kell means to burn Orrin's mill." })).toBe(false);
});

test("a rewrite keeps most of what the thread hides the PC hasn't learned, not only its names", () => {
  const state = { ...openingState, pcKnown: { facts: ["Pell keeps the mill's ledger."], npcs: [] } };
  const { keepsSecrets } = threadGuards(state, "Ash");
  const old = "Pell poisoned Orrin's brother on the magistrate's orders and burns the ledger tonight.";

  expect(keepsSecrets({ old, new: "Pell, who poisoned Orrin's brother on the magistrate's orders, burned the papers." })).toBe(true);
  expect(keepsSecrets({ old, new: "Pell burned the ledger at the mill and watches Orrin's brother." })).toBe(false);
  expect(turnThreadChanges([{ op: "update_plot_thread", thread: old, replacement: "Pell sits by Orrin's ledger." }], state, "Ash", "").dropped).toEqual({
    "a rewrite drops what the thread hides": 1,
  });
});

test("a move that misquotes a thread, or fails, leaves the world as it was and the next Turn plays", async () => {
  play(
    narration("Ash walks to the dock.", { op: "set_scene", location: "The dock", visible_cast: [] }, nextDay()),
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

test("a move is due after hours of story time, on a new day or every few replies, even with no threads, as only a move adds them", () => {
  const at = (timeOfDay: string, date = "1st of Thaw") => ({ date, timeOfDay, day: 1 });
  const before = { ...openingState, plotThreads: ["A thread."], scene: { location: "Here", visibleCast: [] }, storyTime: at("early afternoon") };
  expect(moveDue("a", before, before, 1)).toBe(false);
  // Walking from room to room isn't a pause, as moves that often rewrote the threads out of what they hid.
  expect(moveDue("a", before, { ...before, scene: { location: "There", visibleCast: [] } }, 1)).toBe(false);
  expect(moveDue("a", before, { ...before, storyTime: at("mid afternoon") }, 1)).toBe(false);
  expect(moveDue("b", before, { ...before, storyTime: at("evening") }, 1)).toBe(true);
  expect(moveDue("a", { ...before, storyTime: at("about 9 a.m.") }, { ...before, storyTime: at("10:30 am") }, 1)).toBe(false);
  expect(moveDue("c", { ...before, storyTime: at("about 9 a.m.") }, { ...before, storyTime: at("half past 2 pm") }, 1)).toBe(true);
  expect(moveDue("a", before, { ...before, storyTime: at("a while later") }, 1)).toBe(false);
  expect(moveDue("d", before, { ...before, storyTime: at("dawn", "2nd of Thaw") }, 1)).toBe(true);
  expect(moveDue("a", before, before, MOVE_EVERY)).toBe(true);
  expect(moveDue("e", before, { ...before, plotThreads: [] }, MOVE_EVERY)).toBe(true);
});

test("the fallback move counts replies since the last move, so a move due on time is never followed by one a reply later", () => {
  const before = { ...openingState, storyTime: { date: "1st of Thaw", timeOfDay: "dawn", day: 1 } };
  const nextDay = { ...before, storyTime: { date: "2nd of Thaw", timeOfDay: "dawn", day: 2 } };

  expect(moveDue("spaced", before, nextDay, MOVE_EVERY * 3 + 2)).toBe(true);
  expect(moveDue("spaced", before, before, MOVE_EVERY * 4)).toBe(false);
  expect(moveDue("spaced", before, before, MOVE_EVERY * 4 + 1)).toBe(false);
  expect(moveDue("spaced", before, before, MOVE_EVERY * 4 + 2)).toBe(true);
});

test("the player's Journal edits are still settled after a move, which settles none of them", () => {
  const fact: WorldEdit = { edit: "fact", old: null, new: "Bees sing." };
  const world = { edit: "world" as const, update: { lore_entries: [], removed_lore: [], world_rules: [], plot_threads: [] }, made: 0 };

  expect(journalChange([fact, { ...world, moved: true }])).toContain("Bees sing.");
  expect(journalChange([fact, world])).toBe("");
});

test("a Regenerate drops the move made from the reply it replaces", async () => {
  play(
    narration("Ash walks to the dock.", { op: "set_scene", location: "The dock", visible_cast: [] }, nextDay()),
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

test("a move doesn't rewrite the thread of someone with the PC into an account of the scene, which it did on GLM and DeepSeek", async () => {
  play(
    narration(
      "Ash walks to the dock, where the thief is mending a net.",
      { op: "add_npc", name: "Thief", appearance: "a wiry man in a grey smock" },
      { op: "set_scene", location: "The dock", visible_cast: ["Thief"] },
      nextDay(),
    ),
    // The scene in play, retold as what the thief did: dropped, and asked again while tries remain.
    ...Array.from({ length: 3 }, () =>
      moved({ old: "A thief plans to rob the library at the next high tide.", new: "The thief is mending a net beside Ash now, waiting for the tide." }),
    ),
    narration("Ash watches the barges."),
  );
  const id = createSave();

  const log = await logOf(async () => {
    expect((await turn(id, "I walk to the dock.")).ok).toBe(true);
    expect((await turn(id, "I watch the barges.")).ok).toBe(true);
  }, "info");

  expect(store().latestState(id).plotThreads).toEqual(["A thief plans to rob the library at the next high tide."]);
  // No change is left, so it's asked again, saying why, and then the world stays as it was.
  expect(log).toContain("a rewrite retells the scene in play");
  expect(log).not.toContain("mending");
});

test("a move rewrites the thread of someone with the PC when it keeps to what they plan, without the PC in it", async () => {
  play(
    narration(
      "Ash walks to the dock, where the thief is mending a net.",
      { op: "add_npc", name: "Thief", appearance: "a wiry man in a grey smock" },
      { op: "set_scene", location: "The dock", visible_cast: ["Thief"] },
      nextDay(),
    ),
    moved({ old: "A thief plans to rob the library at the next high tide.", new: "The thief means to rob the library at tonight's tide." }),
    narration("Ash watches the barges."),
  );
  const id = createSave();

  for (const input of ["I walk to the dock.", "I watch the barges."]) expect((await turn(id, input)).ok).toBe(true);

  expect(store().latestState(id).plotThreads).toEqual(["The thief means to rob the library at tonight's tide."]);
});

test("a move adds threads only while fewer than three are open, as an 80-round story's grew to seven that nothing ended", async () => {
  const add = (text: string) => ({ old: null, new: text });
  play(
    narration("Ash walks to the dock.", { op: "set_scene", location: "The dock", visible_cast: [] }, nextDay()),
    moved(add("The ferryman owes the thief."), add("The gulls are omens."), add("The tide is wrong.")),
    narration("Ash watches the barges.", { op: "set_scene", location: "The quay", visible_cast: [] }, nextDay("3rd of Thaw")),
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
    narration("Ash walks to the dock.", { op: "set_scene", location: "The dock", visible_cast: [] }, nextDay()),
    moved(
      { old: "A thief plans to rob the library at the next high tide.", new: "The thief waits by the library." },
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

  expect(store().latestState(id).plotThreads).toEqual(["The thief waits by the library."]);
  expect(log).toContain('"dropped":{"a change changes a thread twice":1,"a change misquotes a thread":1}');
});

test("a move with no usable change is written again, saying why", async () => {
  const told = play(
    narration("Ash walks to the dock.", { op: "set_scene", location: "The dock", visible_cast: [] }, nextDay()),
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
    narration("Ash walks to the dock.", { op: "set_scene", location: "The dock", visible_cast: [] }, nextDay()),
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
    narration("Ash walks to the dock.", { op: "set_scene", location: "The dock", visible_cast: [] }, nextDay()),
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
