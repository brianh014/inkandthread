import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { type Prompt, secretsAbout } from "../src/prompt-assembler";
import { saveStore } from "../src/save-store";
import { applyOperations, type LoreEntry, mergeWorldUpdate, openingState, SecretLoreEntryReply, type State } from "../src/state-applier";
import { threadsByLabel } from "../src/turn-engine";
import { narration, scriptedDice, scriptedTextProvider, startApp, tempFolder } from "./support";

// Threads and Lore Entries hold secrets the narrating call never reads, as people told what only the prompt held (ticket 113).
const TRUTH = "TRUTH-MARK: the keeper sank the boat for the insurance.";
const HIDDEN = "HIDDEN-MARK: the keeper keeps the insurance letter in the lamp room.";
const KEEPER: LoreEntry = { title: "The keeper", keywords: ["keeper"], content: "A grey man who tends the light.", hidden: HIDDEN, alwaysOn: false };

let folder: ReturnType<typeof tempFolder>;
let savesDir: string;
let app: ReturnType<typeof startApp> | undefined;

beforeEach(() => {
  folder = tempFolder();
  savesDir = join(folder.path, "Saves");
});

afterEach(async () => {
  await app?.stop();
  folder.remove();
});

const playWith = (rolls: number[], ...replies: string[]) => {
  const script = scriptedTextProvider(...replies);
  app = startApp(savesDir, script.textProvider, scriptedDice(...rolls));
  return { app, prompts: script.prompts, schemas: script.schemas };
};

async function seeded(theApp: ReturnType<typeof startApp>, sections: Partial<State> = {}) {
  const id = await theApp.createSave();
  const saves = saveStore(savesDir);
  saves.commitTurn(id, saves.latestMessageId(id), "I look around.", "Rain falls.", undefined, (state) => ({
    ...state,
    worldBible: [KEEPER],
    plotThreads: [TRUTH],
    threadsNow: { [TRUTH]: "NOW-MARK: the keeper burns papers at night." },
    ...sections,
  }));
  return id;
}

const text = (prompt: Prompt | undefined) => prompt!.map(({ content }) => content).join("\n");
const stateOf = (id: string) => saveStore(savesDir).latestState(id);
const checkOf = (difficulty: string) => JSON.stringify({ check: { action: "Press the keeper", stakes: "he shuts the door", difficulty } });

test("the narrating call sends a thread by its label and now, and a Lore Entry's hidden part only as a mark", async () => {
  const { app, prompts, schemas } = playWith([], narration("The keeper nods."));
  const id = await seeded(app);

  await app.post(`/saves/${id}/turns`, { input: "I greet the keeper." });

  const sent = text(prompts[0]);
  expect(sent).toContain("NOW-MARK");
  expect(sent).toContain('"thread":"1"');
  expect(sent).toContain("A grey man who tends the light.");
  expect(sent).toContain('"secret":true');
  expect(sent).not.toContain("TRUTH-MARK");
  expect(sent).not.toContain("HIDDEN-MARK");
  expect(JSON.stringify(schemas[0])).not.toContain("TRUTH-MARK");
});

test("a rolled success hands over the truths and hidden parts, after the cached start", async () => {
  const { app, prompts } = playWith([19], checkOf("Hard"), narration("He gives way."));
  const id = await seeded(app);

  await app.post(`/saves/${id}/turns`, { input: "I press the keeper about the boat." });

  expect(text(prompts[0])).not.toContain("TRUTH-MARK");
  expect(text(prompts[1])).toContain("TRUTH-MARK");
  expect(text(prompts[1])).toContain("HIDDEN-MARK");
  expect(prompts[1]![0]).toEqual(prompts[0]![0]!);
});

test("a failed Check hands over nothing", async () => {
  const { app, prompts } = playWith([1], checkOf("Hard"), narration("He shuts the door."));
  const id = await seeded(app);

  await app.post(`/saves/${id}/turns`, { input: "I press the keeper about the boat." });

  expect(text(prompts[1])).not.toContain("TRUTH-MARK");
  expect(text(prompts[1])).not.toContain("HIDDEN-MARK");
});

test("a Turn names a thread by its label, and only one that was handed its truth may amend it", async () => {
  const blind = playWith(
    [],
    narration("The keeper burns more.", { op: "update_plot_thread", thread: "1", now: "He burns the last papers.", truth: "A guess." }),
  );
  const id = await seeded(blind.app);
  await blind.app.post(`/saves/${id}/turns`, { input: "I watch the smoke." });

  expect(stateOf(id).plotThreads).toEqual([TRUTH]);
  expect(stateOf(id).threadsNow).toEqual({ [TRUTH]: "He burns the last papers." });
  await blind.app.stop();

  const amended = "The keeper sank the boat for the insurance, and the PC has seen the letter.";
  const handed = playWith(
    [19],
    checkOf("Hard"),
    narration("He shows the letter.", { op: "update_plot_thread", thread: "1", now: "He waits.", truth: amended }),
  );
  const other = await seeded(handed.app);
  await handed.app.post(`/saves/${other}/turns`, { input: "I press the keeper about the boat." });

  expect(stateOf(other).plotThreads).toEqual([amended]);
});

test("a blind Turn never writes the first now of a thread it can't see into", async () => {
  const { app } = playWith([], narration("Gulls cry.", { op: "update_plot_thread", thread: "1", now: "Invented." }));
  const id = await seeded(app, { threadsNow: {} });

  await app.post(`/saves/${id}/turns`, { input: "I listen." });

  expect(stateOf(id).threadsNow).toEqual({});
});

test("a Lore Entry's hidden part outlives the Narrator's rewrite and a World Change that leaves it out", () => {
  const state = { ...structuredClone(openingState), worldBible: [structuredClone(KEEPER)] };
  const { next } = applyOperations(state, [{ op: "update_lore_entry", title: "The keeper", keywords: ["keeper"], content: "Older now." }]);
  expect(next.worldBible[0]).toMatchObject({ content: "Older now.", hidden: HIDDEN });

  const world = mergeWorldUpdate(next, {
    lore_entries: [{ title: "The keeper", keywords: ["keeper", "lamp", "light"], content: "Retired.", hidden: null }],
    removed_lore: [],
    world_rules: [],
    plot_threads: [],
  });
  expect(world.worldBible[0]).toMatchObject({ content: "Retired.", hidden: HIDDEN });
});

test("a secret the Narrator writes into an entry's content is no longer kept, and a blank one in a reply is none", () => {
  const state = { ...structuredClone(openingState), worldBible: [structuredClone(KEEPER)] };
  const told = "A grey man who tends the light, and keeps the insurance letter in the lamp room.";
  const { next } = applyOperations(state, [{ op: "update_lore_entry", title: "The keeper", keywords: ["keeper"], content: told }]);
  expect(next.worldBible[0]!.hidden).toBeUndefined();

  expect(SecretLoreEntryReply.parse({ title: "The keeper", keywords: ["keeper", "lamp", "light"], content: "A grey man.", hidden: " " }).hidden).toBeNull();
});

test("a label written loosely still finds its thread, and a quoted truth is matched as before", () => {
  const state = { plotThreads: ["The duke plots.", "The tide is wrong."], threadsNow: { "The duke plots.": "He waits.", "The tide is wrong.": "It rises." } };
  const update = (thread: string) => ({ op: "update_plot_thread" as const, thread, now: "Moved.", truth: null });

  const { operations, dropped } = threadsByLabel([update("#2"), update("Thread 1:"), update("The duke plots."), update("7")], state, new Set());

  expect(operations.map(({ thread }) => thread)).toEqual(["The tide is wrong.", "The duke plots.", "The duke plots."]);
  expect(dropped).toEqual({ unmatched: 1, blind: 0 });
});

test("a success hands over only the secrets of what the Check and the move are about", async () => {
  const other = JSON.stringify({ check: { action: "Climb the sea wall", stakes: "a fall onto the rocks", difficulty: "Hard" } });
  const { app, prompts } = playWith([19], other, narration("She reaches the top."));
  const id = await seeded(app);

  await app.post(`/saves/${id}/turns`, { input: "I climb the sea wall." });

  expect(text(prompts[1])).not.toContain("TRUTH-MARK");
  expect(text(prompts[1])).not.toContain("HIDDEN-MARK");
});

test("what a move names finds its secrets in any case, and threads through an entry with no secret", () => {
  const state = {
    npcs: [{ name: "Ada", appearance: "a tall woman" }],
    worldBible: [
      { title: "Lamp Room", keywords: ["lamp room"], content: "The top of the light.", hidden: "LETTER-MARK", alwaysOn: false },
      { title: "Harbor warehouse", keywords: ["warehouse"], content: "A long shed.", alwaysOn: false },
    ],
    plotThreads: ["The guild hides powder in the warehouse.", "Ada sank the boat."],
  };

  const found = secretsAbout(state, "I search the LAMP ROOM and break into the warehouse.");

  expect(found.hidden).toEqual([["Lamp Room", "LETTER-MARK"]]);
  expect(found.threads).toEqual([["1", "The guild hides powder in the warehouse."]]);
});

test("a success may amend only the truths it was handed", async () => {
  const other = JSON.stringify({ check: { action: "Climb the sea wall", stakes: "a fall", difficulty: "Hard" } });
  const { app } = playWith([19], other, narration("She reaches the top.", { op: "update_plot_thread", thread: "1", now: "He waits.", truth: "A guess." }));
  const id = await seeded(app);

  await app.post(`/saves/${id}/turns`, { input: "I climb the sea wall." });

  expect(stateOf(id).plotThreads).toEqual([TRUTH]);
});
