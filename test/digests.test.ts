import { expect, test } from "bun:test";
import { CHECK_FACTS, foldKnows, KEEP_KNOWS, knowsDue, pickDrops, RECENT_FACTS, sortFacts } from "../src/digests";
import { assemblePrompt } from "../src/prompt-assembler";
import type { SaveStore } from "../src/save-store";
import { applyEdit, FOLD_NPC_KNOWS, openingState, type State, type WorldEdit } from "../src/state-applier";
import { scriptedTextProvider } from "./support";

const facts = (count: number) => Array.from({ length: count }, (_, at) => `Fact ${at}.`);
const stateWith = (list: string[], olderFacts: Partial<State["olderFacts"]> = {}): State => ({
  ...structuredClone(openingState),
  pcKnown: { facts: list, npcs: [] },
  olderFacts: { held: [], dropped: [], checked: 0, ...olderFacts },
});
const empty = { lore_entries: [], removed_lore: [], world_rules: [], plot_threads: [] };
const signal = new AbortController().signal;
const reply = (...drops: { fact: number; by: number; kind: string }[]) => JSON.stringify({ drops });

/** Just what the pause reads and writes of a Save. */
const savesWith = (state: State) => {
  const changes: WorldEdit[][] = [];
  const saves = { latestMessageId: () => 7, latestState: () => state, addWorldChange: (_id: string, _on: number, edits: WorldEdit[]) => changes.push(edits) };
  return { saves: saves as unknown as SaveStore, changes };
};

test("only a later fact that is sent can drop an older one, and never in a chain", async () => {
  const list = facts(RECENT_FACTS + 20);
  const scribe = scriptedTextProvider(
    reply(
      { fact: 1, by: 5, kind: "repeat" },
      // Not newer, past the facts looked at, past the list, and twice.
      { fact: 6, by: 3, kind: "superseded" },
      { fact: 30, by: 70, kind: "repeat" },
      { fact: 2, by: 999, kind: "repeat" },
      { fact: 1, by: 9, kind: "repeat" },
      // Its later fact is dropped too.
      { fact: 4, by: 7, kind: "superseded" },
      { fact: 7, by: 8, kind: "repeat" },
    ),
  );

  const { pairs, refused } = await pickDrops(scribe.textProvider, stateWith(list), signal);

  expect(pairs).toEqual([
    { fact: "Fact 0.", by: "Fact 4.", kind: "repeat" },
    { fact: "Fact 6.", by: "Fact 7.", kind: "repeat" },
  ]);
  expect(refused).toBe(5);
});

test("a reply marking more than a quarter of the facts drops none", async () => {
  const list = facts(RECENT_FACTS + 8);
  const scribe = scriptedTextProvider(reply(...[1, 2, 3].map((fact) => ({ fact, by: 50, kind: "repeat" }))));

  await expect(pickDrops(scribe.textProvider, stateWith(list), signal)).rejects.toThrow("marked 3 of 8");
});

test("the pause holds the older facts up front and drops what the Scribe found, and still holds them when it fails", async () => {
  const list = facts(RECENT_FACTS + CHECK_FACTS);
  const checked = savesWith(stateWith(list));
  await sortFacts(scriptedTextProvider(reply({ fact: 1, by: 2, kind: "repeat" })).textProvider, checked.saves, "save", signal);

  expect(checked.changes[0]![0]).toMatchObject({ moved: true, facts: { held: list.slice(0, CHECK_FACTS), dropped: ["Fact 0."], checked: CHECK_FACTS } });

  const failed = savesWith(stateWith(list));
  await sortFacts(scriptedTextProvider(new Error("down")).textProvider, failed.saves, "save", signal);

  expect(failed.changes[0]![0]).toMatchObject({ facts: { held: list.slice(0, CHECK_FACTS), dropped: [], checked: 0 } });
});

test("a pause with too few newly held facts asks the Scribe nothing, and one that changes nothing writes nothing", async () => {
  const list = facts(RECENT_FACTS + CHECK_FACTS);
  const scribe = scriptedTextProvider();
  const moved = savesWith(stateWith(list, { checked: 1 }));
  const unchanged = savesWith(stateWith(list, { held: list.slice(0, CHECK_FACTS), checked: CHECK_FACTS }));

  await sortFacts(scribe.textProvider, moved.saves, "save", signal);
  await sortFacts(scribe.textProvider, unchanged.saves, "save", signal);

  expect(scribe.prompts).toHaveLength(0);
  expect(moved.changes[0]![0]).toMatchObject({ facts: { held: list.slice(0, CHECK_FACTS), checked: 1 } });
  expect(unchanged.changes).toHaveLength(0);
});

test("the Narrator reads held facts word for word up front, the rest with the state, and dropped ones nowhere", () => {
  const prompt = assemblePrompt({
    save: { worldBrief: "A drowned city", pc: { name: "Ash" }, startingHook: "" },
    state: stateWith(["Held fact.", "Dropped fact.", "New fact."], { held: ["Held fact.", "Dropped fact."], dropped: ["Dropped fact."] }),
    messages: [],
    modelInstructions: "",
    input: "I wait.",
    responseSchema: "{}",
    promptStyle: null,
  });
  const rest = prompt
    .slice(1)
    .map(({ content }) => content)
    .join("\n");

  expect(prompt[0]!.content).toContain('["Held fact."]');
  expect(prompt.map(({ content }) => content).join("\n")).not.toContain("Dropped fact.");
  expect(rest).not.toContain("Held fact.");
  expect(rest).toContain("New fact.");
});

test("what someone knows folds past the limit, keeping their newest and never their parts", () => {
  const knows = [...facts(FOLD_NPC_KNOWS), "Their part."];
  const due = knowsDue({ npcKnows: { Wren: knows, Short: facts(3) }, npcParts: { Wren: ["Their part."] } });

  expect(Object.keys(due)).toEqual(["Wren"]);
  expect(due.Wren).toEqual(facts(FOLD_NPC_KNOWS).slice(0, -KEEP_KNOWS));
});

test("a fold puts its summary first, in place of the entries it stands for, once only", () => {
  const state: State = { ...structuredClone(openingState), npcKnows: { Wren: ["Old a.", "Old b.", "New."] } };
  const fold: WorldEdit = {
    edit: "world",
    update: empty,
    moved: true,
    folded: { Wren: { knew: ["Old a.", "Old b."], into: "Summary." }, Gone: { knew: [], into: "Never met." } },
    facts: { held: ["Old fact."], dropped: [], checked: 1 },
  };
  const next = applyEdit(applyEdit(state, fold), fold);

  expect(next.npcKnows).toEqual({ Wren: ["Summary.", "New."] });
  expect(next.olderFacts).toEqual({ held: ["Old fact."], dropped: [], checked: 1 });
});

test("the Scribe's folds reach the Save as a hidden World Change, for the people it was asked about", async () => {
  const { saves, changes } = savesWith({ ...structuredClone(openingState), npcKnows: { Wren: facts(FOLD_NPC_KNOWS + 1), Other: facts(2) } });
  const scribe = scriptedTextProvider(
    JSON.stringify({
      people: [
        { name: "Wren", summary: "Wren knows the old facts." },
        { name: "Stranger", summary: "Not asked." },
      ],
    }),
  );

  await foldKnows(scribe.textProvider, saves, "save", signal);

  expect(changes[0]![0]).toMatchObject({ folded: { Wren: { knew: facts(FOLD_NPC_KNOWS + 1).slice(0, -KEEP_KNOWS), into: "Wren knows the old facts." } } });
  expect(Object.keys((changes[0]![0] as { folded: object }).folded)).toEqual(["Wren"]);
});
