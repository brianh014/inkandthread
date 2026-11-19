import { afterEach, beforeEach, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { startServer } from "../src/rest-api";
import { saveStore } from "../src/save-store";
import { settingsStore } from "../src/settings-store";
import { applyEdit, MAX_NPC_KNOWS, openingState, type WorldEdit } from "../src/state-applier";
import { journalChange } from "../src/prompt-assembler";
import { MOVE_EVERY, moveDue, turnThreadChanges } from "../src/world-moves-on";
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

function play(...replies: (string | Error | Promise<string>)[]) {
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

const THIEF = "A thief plans to rob the library at the next high tide.";
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
      plotThreads: [THIEF],
      worldBible: [
        { title: "The thief", keywords: ["thief"], content: "The thief is the librarian's own son.", alwaysOn: false },
        { title: "Gulls", keywords: ["gull"], content: "Gulls nest on the dome.", alwaysOn: false },
      ],
    },
  });
const turn = (id: string, input: string) =>
  fetch(new URL(`/saves/${id}/turns`, server.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input }) });
const moved = (...plot_threads: object[]) => JSON.stringify({ plot_threads });
/** A move's change: a thread's new now, or null to remove it, and a truth only to add one. */
const change = (thread: string | null, now: string | null, truth: string | null = null) => ({ thread, truth, now });
// A new day, which makes a move due.
const nextDay = (date = "2nd of Thaw") => ({ op: "set_story_time", days_passed: 1, date, time_of_day: "dawn" });

test("on a new day the world moves on out of sight, rewriting a thread's now and keeping its truth, and the next Turn reads both", async () => {
  const told = play(
    narration(
      "Ash walks to the dock.",
      { op: "add_npc", name: "Ferryman", appearance: "a stooped man in oilskins" },
      { op: "set_scene", location: "The dock", visible_cast: ["Ferryman"] },
      nextDay(),
    ),
    moved(change(THIEF, "The thief has robbed the library and hides the books on a barge.")),
    narration("Ash watches the barges."),
  );
  const id = createSave();

  const log = await logOf(async () => {
    expect((await turn(id, "I walk to the dock.")).ok).toBe(true);
    expect((await turn(id, "I watch the barges.")).ok).toBe(true);
  }, "info");

  // The move was asked between the Turns, with the threads and the story so far.
  expect(told.prompts.length).toBe(3);
  expect(JSON.parse(told.prompts[1]!.at(-1)!.content).plot_threads).toEqual([{ truth: THIEF, now: "" }]);
  // With the Lore Entries its threads name, so a move keeps who is behind each one true to the world.
  expect(told.prompts[1]!.at(-1)!.content).toContain("the librarian's own son");
  expect(told.prompts[1]!.at(-1)!.content).not.toContain("Gulls nest");
  // And the world rules, so a move keeps to the setting's own facts.
  expect(told.prompts[1]!.at(-1)!.content).toContain("The city has one boat.");
  // And who is with the PC, so a move doesn't retell the scene in play as what they did out of sight.
  expect(told.prompts[1]!.at(-1)!.content).toContain('"visible_cast":["Ferryman"]');
  const next = told.prompts[2]!.map(({ content }) => content).join("\n");
  expect(next).toContain(JSON.stringify({ truth: THIEF, now: "The thief has robbed the library and hides the books on a barge." }));
  expect(store().latestState(id).plotThreads).toEqual([THIEF]);
  expect(store().latestState(id).threadsNow).toEqual({ [THIEF]: "The thief has robbed the library and hides the books on a barge." });
  expect(log).toContain('"threads":1,"rewritten":1,"added":0,"removed":0');
  expect(log).not.toContain("barge");
});

test("a move can't change what a thread hides: a truth it gives for a rewrite is left out, and its now is kept", async () => {
  play(
    narration("Ash walks to the dock.", { op: "set_scene", location: "The dock", visible_cast: [] }, nextDay()),
    moved(change(THIEF, "The thief waits at the dock for the tide.", "Someone waits at the dock.")),
    narration("Ash watches the barges."),
  );
  const id = createSave();

  const log = await logOf(async () => {
    for (const input of ["I walk to the dock.", "I watch the barges."]) expect((await turn(id, input)).ok).toBe(true);
  }, "info");

  expect(store().latestState(id).plotThreads).toEqual([THIEF]);
  expect(store().latestState(id).threadsNow).toEqual({ [THIEF]: "The thief waits at the dock for the tide." });
  expect(log).toContain('"truthsIgnored":1');
});

test("a thread from a Save before the split has its one text as its truth and no now, and is moved on by its now", async () => {
  play(
    narration("Ash walks to the dock.", { op: "set_scene", location: "The dock", visible_cast: [] }, nextDay()),
    moved(change(THIEF, "The thief has robbed the library.")),
    narration("Ash watches the barges."),
  );
  // As an older Save or a bench world holds it: one text per thread, and no threadsNow.
  const id = createSave();
  expect(store().latestState(id).threadsNow).toEqual({});

  for (const input of ["I walk to the dock.", "I watch the barges."]) expect((await turn(id, input)).ok).toBe(true);

  expect(store().latestState(id).plotThreads).toEqual([THIEF]);
  expect(store().latestState(id).threadsNow).toEqual({ [THIEF]: "The thief has robbed the library." });
});

test("an old World Change's rewrite of a thread's one text still applies, as its truth", () => {
  const edit: WorldEdit = {
    edit: "world",
    update: { lore_entries: [], removed_lore: [], world_rules: [], plot_threads: [{ old: THIEF, new: "The thief has fled." }] },
  };
  const state = { ...structuredClone(openingState), plotThreads: [THIEF], threadsNow: { [THIEF]: "He waits." } };
  const next = applyEdit(state, edit);

  expect(next.plotThreads).toEqual(["The thief has fled."]);
  // A truth rewritten by a World Change starts with no now, as the old one may no longer fit it.
  expect(next.threadsNow).toEqual({});
});

test("a World Change sent while the world is moving on waits for the move, so it reads the thread as moved", async () => {
  let finish: (reply: string) => void = () => {};
  const told = play(
    narration("Ash walks to the dock.", { op: "set_scene", location: "The dock", visible_cast: [] }, nextDay()),
    new Promise<string>((resolve) => (finish = resolve)),
    JSON.stringify({
      lore_entries: [],
      removed_lore: [],
      world_rules: [{ old: null, new: "The mayor rules the city." }],
      plot_threads: [],
      world_brief: null,
      summary: null,
      facts: [],
      npc_summaries: [],
    }),
  );
  const id = createSave();
  await (await turn(id, "I walk to the dock.")).text();
  const worldChange = fetch(new URL(`/saves/${id}/world-change`, server.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ change: "the thief is the mayor" }),
  });
  await Bun.sleep(50);
  // Still waiting for the move, so the World Change hasn't asked yet.
  expect(told.prompts.length).toBe(2);
  finish(moved(change(THIEF, "The thief has robbed the library and hides the books on a barge.")));

  expect((await worldChange).ok).toBe(true);
  expect(told.prompts[2]!.map(({ content }) => content).join("\n")).toContain("hides the books on a barge");
});

test("a move reads the Lore Entries the story names too, not only its threads', so a thread it adds keeps to the world", async () => {
  const told = play(
    narration(
      "Ash catches the thief where a gull nests on the dome.",
      { op: "resolve_plot_thread", thread: THIEF },
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
  const told = play(
    narration(
      "Ash catches the thief at the dock.",
      { op: "resolve_plot_thread", thread: THIEF },
      { op: "set_scene", location: "The dock", visible_cast: [] },
      nextDay(),
    ),
    moved(change(THIEF, null), change(null, "He walks the docks at night.", "The thief's father wants him back.")),
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
  expect(asked.plot_threads).toEqual([{ truth: THIEF, now: "" }]);
  expect(asked.asked_to_close).toEqual([THIEF]);
  expect(store().latestState(id).plotThreads).toEqual(["The thief's father wants him back."]);
  expect(store().latestState(id).threadsNow).toEqual({ "The thief's father wants him back.": "He walks the docks at night." });
  expect(log).toContain('"closeAsked":1');
  expect(log).toContain('"asked":1,"closed":1');
});

test("a close ask follows its thread through a later amended truth, and a Turn logs only the asks that matched a thread", async () => {
  const AMENDED = "The thief, the librarian's son, plans to rob the library at the next high tide.";
  const told = play(
    narration("Ash hears of a ghost.", { op: "resolve_plot_thread", thread: "A ghost haunts the dome." }),
    narration("Ash corners the thief.", { op: "resolve_plot_thread", thread: THIEF }),
    narration("The thief slips away.", { op: "update_plot_thread", thread: THIEF, now: "He hides.", truth: AMENDED }, nextDay()),
    moved(),
    narration("Ash looks out."),
  );
  const id = createSave();

  const log = await logOf(async () => {
    for (const input of ["I listen.", "I grab him.", "I chase him.", "I look out."]) expect((await turn(id, input)).ok).toBe(true);
  }, "info");

  expect(JSON.parse(told.prompts[3]!.at(-1)!.content).asked_to_close).toEqual([AMENDED]);
  expect(log).toContain('"closeAsked":0');
  expect(log).toContain('"closeAsked":1');
  expect(log).toContain('Thread truths amended {"route":"/saves/:id/turns","save":"');
});

test("a Turn amends a thread's truth only when the reply names someone the thread names, and otherwise keeps only its now", () => {
  const state = { ...openingState, npcs: [{ name: "Grout", appearance: "" }], plotThreads: ["Grout hides the ledger.", "The tide is wrong."] };
  const operations = [
    { op: "update_plot_thread", thread: "Grout hides the ledger.", now: "Grout waits.", truth: "Grout hid the ledger, and Ash found it." },
    { op: "update_plot_thread", thread: "The tide is wrong.", now: "It turns.", truth: "The tide was always wrong." },
    { op: "update_plot_thread", thread: "Grout hides the ledger.", now: "Grout runs." },
  ] as Parameters<typeof turnThreadChanges>[0];

  expect(turnThreadChanges(operations, state, "Grout lifts the ledger from the chimney.")).toEqual({ kept: operations, dropped: {} });
  const { kept, dropped } = turnThreadChanges(operations, state, "Kit counts his coins.");
  expect(kept).toEqual([{ ...operations[0]!, truth: null } as never, operations[1]!, operations[2]!]);
  expect(dropped).toEqual({ "a truth amended by a reply that never names its people": 1 });
});

test("a move that misquotes a thread, or fails, leaves the world as it was and the next Turn plays", async () => {
  play(
    narration("Ash walks to the dock.", { op: "set_scene", location: "The dock", visible_cast: [] }, nextDay()),
    ...Array.from({ length: 3 }, () => moved(change("No such thread.", "Something else."))),
    narration("Ash watches the barges."),
  );
  const id = createSave();

  const log = await logOf(async () => {
    expect((await turn(id, "I walk to the dock.")).ok).toBe(true);
    expect((await turn(id, "I watch the barges.")).ok).toBe(true);
  }, "info");

  expect(store().latestState(id).plotThreads).toEqual([THIEF]);
  expect(store().latestState(id).threadsNow).toEqual({});
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
    moved(change(THIEF, "The thief has robbed the library.")),
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
  expect(store().latestState(id).threadsNow).toEqual({});
});

test("a move adds threads only while fewer than three are open, as an 80-round story's grew to seven that nothing ended", async () => {
  const add = (truth: string) => change(null, "Soon.", truth);
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

  expect(store().latestState(id).plotThreads).toEqual([THIEF, "The ferryman owes the thief.", "The gulls are omens."]);
  expect(log).toContain('"overflow":1');
  expect(log).not.toContain("World didn't move on");
});

test("a move removes a thread only when the replies show its people or a Turn asked, and never below three open without an add", async () => {
  const PELL = "Mr Pell means to burn the mill.";
  const told = play(
    narration("Ash walks to the dock.", { op: "set_scene", location: "The dock", visible_cast: [] }, nextDay()),
    // Mr Pell is nowhere in the replies, so his thread stays.
    moved(change(PELL, null), change(null, "Soon.", "The tide is wrong.")),
    narration("Ash sees Mr Pell hanged at the quay.", { op: "set_scene", location: "The quay", visible_cast: [] }, nextDay("3rd of Thaw")),
    // Shown now, but removing it would leave one thread and add none, so it's asked again.
    moved(change(PELL, null)),
    moved(change(PELL, null), change(null, "Soon.", "The gulls are omens.")),
    narration("Ash goes home."),
  );
  const id = store().create({
    worldBrief: "A drowned city",
    pc: { name: "Ash" },
    opening: {
      inventory: { wearing: [], carrying: [] },
      scene: { location: "The library", visibleCast: [] },
      summary: "",
      worldRules: [],
      plotThreads: [PELL],
      worldBible: [{ title: "The miller", keywords: ["Mr Pell"], content: "", alwaysOn: false }],
    },
  });

  const log = await logOf(async () => {
    for (const input of ["I walk to the dock.", "I walk to the quay.", "I go home."]) expect((await turn(id, input)).ok).toBe(true);
  }, "info");

  expect(store().latestState(id).plotThreads).toEqual(["The tide is wrong.", "The gulls are omens."]);
  expect(log).toContain('"dropped":{"a remove of a thread whose people the replies never name":1}');
  expect(told.prompts.some((prompt) => prompt.at(-1)!.content.includes("a remove leaves fewer than three threads and adds none"))).toBe(true);
});

test("a move keeps its usable changes and drops only those that change a thread twice, misquote one or add one without its truth", async () => {
  play(
    narration("Ash walks to the dock.", { op: "set_scene", location: "The dock", visible_cast: [] }, nextDay()),
    moved(change(THIEF, "The thief waits by the library."), change(THIEF, "The thief strikes."), change("A thread that isn't there.", "x"), change(null, "x")),
    narration("Ash watches the barges."),
  );
  const id = createSave();

  const log = await logOf(async () => {
    expect((await turn(id, "I walk to the dock.")).ok).toBe(true);
    expect((await turn(id, "I watch the barges.")).ok).toBe(true);
  }, "info");

  expect(store().latestState(id).threadsNow).toEqual({ [THIEF]: "The thief waits by the library." });
  expect(log).toContain('"dropped":{"a change changes a thread twice":1,"a change misquotes a thread":1,"an add without its truth and now":1}');
});

test("a move sent as an add carrying an open thread's truth rewrites that thread, as GLM sent its rewrites so", async () => {
  play(
    narration("Ash walks to the dock.", { op: "set_scene", location: "The dock", visible_cast: [] }, nextDay()),
    moved(change(null, "The thief waits by the library.", THIEF), change(null, "Soon.", "The tide is wrong."), change(null, "Soon.", "The gulls are omens.")),
    narration("Ash watches the barges."),
  );
  const id = createSave();

  const log = await logOf(async () => {
    for (const input of ["I walk to the dock.", "I watch the barges."]) expect((await turn(id, input)).ok).toBe(true);
  }, "info");

  expect(store().latestState(id).plotThreads).toEqual([THIEF, "The tide is wrong.", "The gulls are omens."]);
  expect(store().latestState(id).threadsNow[THIEF]).toBe("The thief waits by the library.");
  expect(log).toContain('"rewritten":1,"added":2');
  expect(log).not.toContain("overflow");
});

test("the schemas a move and a Turn are sent name a thread only by an open truth, as models misquoted the truths they copied", async () => {
  const told = play(
    narration("Ash walks to the dock.", { op: "set_scene", location: "The dock", visible_cast: [] }, nextDay()),
    moved(change(THIEF, "The thief waits by the library.")),
    narration("Ash watches the barges."),
  );
  const id = createSave();

  for (const input of ["I walk to the dock.", "I watch the barges."]) expect((await turn(id, input)).ok).toBe(true);

  // Every thread field in each schema, a move's and both Turns', held to the open truth.
  const threadFields = (schema: unknown) => JSON.stringify(schema).match(/"thread":\{[^}]*\}/g) ?? [];
  for (const schema of told.schemas) {
    expect(threadFields(schema).length).toBeGreaterThan(0);
    for (const field of threadFields(schema)) expect(field).toContain(`"enum":[${JSON.stringify(THIEF)}]`);
  }
});

test("a move gives each person a thread names their own part of it, kept as what they know, even for someone not yet met", async () => {
  const ferryman = "He rowed a hooded man across at the last tide.";
  const oren = "He is the thief, and fears the tide will turn early.";
  const told = play(
    narration(
      "Ash walks to the dock.",
      { op: "add_npc", name: "Ferryman", appearance: "a stooped man in oilskins" },
      { op: "set_scene", location: "The dock", visible_cast: ["Ferryman"] },
      { op: "npc_learns", name: "Ferryman", fact: "Ash asked him about boats." },
      nextDay(),
    ),
    moved({
      ...change(THIEF, "The Ferryman, at the dock, will row the thief out at the next tide."),
      knows: [
        { name: "Ferryman", knows: ferryman },
        { name: "Oren", knows: oren },
      ],
    }),
    narration("A thin man steps from a barge.", { op: "add_npc", name: "Oren Vell", appearance: "a thin man" }, nextDay("3rd of Thaw")),
    moved(change(THIEF, "The thief rows out.")),
    narration("Ash watches the barges."),
  );
  const id = createSave();

  const log = await logOf(async () => {
    for (const input of ["I walk to the dock.", "I watch the barge.", "I wait."]) expect((await turn(id, input)).ok).toBe(true);
  }, "info");

  // Kept as what each knows, someone met later under the name they were met by.
  expect(store().latestState(id).npcKnows).toEqual({ Ferryman: ["Ash asked him about boats.", ferryman], "Oren Vell": [oren] });
  // The Narrator reads the Ferryman's part while he is in the scene.
  expect(told.prompts[2]!.map(({ content }) => content).join("\n")).toContain(ferryman);
  // The next move reads what the people its threads name already know.
  expect(JSON.parse(told.prompts[3]!.at(-1)!.content).npc_knows).toEqual({ Ferryman: ["Ash asked him about boats.", ferryman] });
  expect(log).toContain('"knows":2');
  expect(log).not.toContain("hooded");
});

test("a move asks a part of each person a thread names who has none for it, though they learned other things in play, and asks again once when one is missing", async () => {
  const drowned = "Silas Grout drowned the harbourmaster on the vicar's orders.";
  const part = "He held the harbourmaster under, and the vicar paid him.";
  const told = play(
    narration(
      "Ash meets the sexton.",
      { op: "add_npc", name: "Silas Grout", appearance: "a huge man" },
      { op: "npc_learns", name: "Silas Grout", fact: "Ash asked who dug the grave." },
      nextDay(),
    ),
    moved(change(drowned, "Grout digs a grave.")),
    moved({ ...change(drowned, "Grout digs a grave."), knows: [{ name: "Grout", knows: part }] }),
    narration("Ash waits.", nextDay("3rd of Thaw")),
    moved(change(drowned, "Grout fills the grave.")),
    narration("Ash waits again."),
  );
  const id = store().create({
    worldBrief: "A harbour town",
    pc: { name: "Ash" },
    opening: {
      inventory: { wearing: [], carrying: [] },
      scene: { location: "The quay", visibleCast: [] },
      summary: "",
      worldRules: [],
      plotThreads: [drowned],
      worldBible: [],
    },
  });

  const log = await logOf(async () => {
    for (const input of ["I meet him.", "I wait.", "I wait again."]) expect((await turn(id, input)).ok).toBe(true);
  }, "info");

  // Asked of Grout, though what he learned in play already sat in npc_knows.
  expect(JSON.parse(told.prompts[1]!.at(-1)!.content).plot_threads).toEqual([{ truth: drowned, now: "", without_part: ["Silas Grout"] }]);
  // The move that gave none was asked again, and the next move asks him no more.
  expect(told.prompts[2]!.at(-1)!.content).toContain("without_part");
  expect(JSON.parse(told.prompts[4]!.at(-1)!.content).plot_threads).toEqual([{ truth: drowned, now: "Grout digs a grave." }]);
  expect(store().latestState(id).npcKnows["Silas Grout"]).toEqual(["Ash asked who dug the grave.", part]);
  expect(log).not.toContain('"withoutPart"');
});

test("a move asks no part of the dead, as a dead man was asked what he knew", async () => {
  const drowned = "Silas Grout drowned Tobias Crane on the vicar's orders.";
  const told = play(
    narration(
      "Ash meets the sexton beside the body.",
      { op: "add_npc", name: "Silas Grout", appearance: "a huge man" },
      { op: "add_npc", name: "Tobias Crane", appearance: "an old man, drowned" },
      nextDay(),
    ),
    moved({ ...change(drowned, "Grout digs a grave."), knows: [{ name: "Grout", knows: "He held Crane under." }] }),
    narration("Ash waits."),
  );
  const id = store().create({
    worldBrief: "A harbour town",
    pc: { name: "Ash" },
    opening: {
      inventory: { wearing: [], carrying: [] },
      scene: { location: "The quay", visibleCast: [] },
      summary: "",
      worldRules: [],
      plotThreads: [drowned],
      worldBible: [{ title: "Tobias Crane", keywords: ["Crane", "body", "drowned"], content: "The harbourmaster, drowned.", alwaysOn: false }],
    },
  });

  for (const input of ["I meet him.", "I wait."]) expect((await turn(id, input)).ok).toBe(true);

  expect(JSON.parse(told.prompts[1]!.at(-1)!.content).plot_threads).toEqual([{ truth: drowned, now: "", without_part: ["Silas Grout"] }]);
});

test("what a move gives someone to know is capped, so it never grows without bound", () => {
  const known = Array.from({ length: MAX_NPC_KNOWS }, (_, at) => `Fact ${at}.`);
  const state = { ...openingState, npcs: [{ name: "Ferryman", appearance: "" }], npcKnows: { Ferryman: known } };
  const edit: WorldEdit = {
    edit: "world",
    update: { lore_entries: [], removed_lore: [], world_rules: [], plot_threads: [] },
    knows: { Ferryman: ["Fact 3.", "New."] },
    moved: true,
  };

  expect(applyEdit(state, edit).npcKnows.Ferryman).toEqual([...known.slice(1), "New."]);
});

test("a now that waits on the PC, puts someone with the PC elsewhere or gives them what only a secret holds is asked again once", async () => {
  const drowned = "Silas Grout drowned the harbourmaster on the vicar's orders.";
  const hidden = "The ledger is hidden in the cottage chimney, and the vicar is searching for it.";
  const part = { name: "Silas Grout", knows: "He held the harbourmaster under for the vicar." };
  const committed = "Grout, in the crypt with Ash, will dig a fresh grave in the churchyard by dawn.";
  const told = play(
    narration(
      "Ash meets the sexton in the crypt.",
      { op: "add_npc", name: "Silas Grout", appearance: "a huge man" },
      { op: "set_scene", location: "The crypt", visible_cast: ["Silas Grout"] },
      nextDay(),
    ),
    moved({ ...change(drowned, "Grout is at the cottage, pulling at the chimney, and will deal with Ash if she presses."), knows: [part] }),
    moved({ ...change(drowned, committed), knows: [part] }),
    narration("Ash waits."),
  );
  const id = store().create({
    worldBrief: "A harbour town",
    pc: { name: "Ash" },
    opening: {
      inventory: { wearing: [], carrying: [] },
      scene: { location: "The quay", visibleCast: [] },
      summary: "",
      worldRules: [],
      plotThreads: [drowned, hidden],
      worldBible: [],
    },
  });

  const log = await logOf(async () => {
    for (const input of ["I meet him.", "I wait."]) expect((await turn(id, input)).ok).toBe(true);
  }, "info");

  const again = told.prompts[2]!.at(-1)!.content;
  for (const why of ["a now waits on what the PC might do", "a now puts someone with the PC somewhere else", "a now gives someone what only a secret holds"])
    expect(again).toContain(why);
  expect(log).toContain("Nows asked again");
  expect(store().latestState(id).threadsNow[drowned]).toBe(committed);
});

test("a move with no usable change is written again, saying why", async () => {
  const told = play(
    narration("Ash walks to the dock.", { op: "set_scene", location: "The dock", visible_cast: [] }, nextDay()),
    moved(change("A thread that isn't there.", "x")),
    moved(),
    narration("Ash watches the barges."),
  );
  const id = createSave();

  expect((await turn(id, "I walk to the dock.")).ok).toBe(true);
  expect((await turn(id, "I watch the barges.")).ok).toBe(true);

  expect(told.prompts.some((prompt) => prompt.at(-1)!.content.includes("a change misquotes a thread"))).toBe(true);
});
