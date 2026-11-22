import { expect, test } from "bun:test";
import { foldKnows, holdFacts, KEEP_KNOWS, knowsDue, RECENT_FACTS } from "../src/digests";
import { assemblePrompt } from "../src/prompt-assembler";
import type { SaveStore } from "../src/save-store";
import { applyEdit, FOLD_NPC_KNOWS, openingState, type State, type WorldEdit } from "../src/state-applier";
import { scriptedTextProvider } from "./support";

const facts = (count: number) => Array.from({ length: count }, (_, at) => `Fact ${at}.`);
const stateWith = (list: string[], heldFacts: string[] = []): State => ({ ...structuredClone(openingState), pcKnown: { facts: list, npcs: [] }, heldFacts });
const empty = { lore_entries: [], removed_lore: [], world_rules: [], plot_threads: [] };
const signal = new AbortController().signal;

/** Just what the pause reads and writes of a Save. */
const savesWith = (state: State) => {
  const changes: WorldEdit[][] = [];
  const saves = { latestMessageId: () => 7, latestState: () => state, addWorldChange: (_id: string, _on: number, edits: WorldEdit[]) => changes.push(edits) };
  return { saves: saves as unknown as SaveStore, changes };
};

test("the pause holds the facts older than the newest up front, and writes nothing when they haven't changed", () => {
  const list = facts(RECENT_FACTS + 5);
  const moved = savesWith(stateWith(list));
  const unchanged = savesWith(stateWith(list, list.slice(0, 5)));

  holdFacts(moved.saves, "save");
  holdFacts(unchanged.saves, "save");

  expect(moved.changes[0]![0]).toMatchObject({ moved: true, held: list.slice(0, 5) });
  expect(unchanged.changes).toHaveLength(0);
});

test("the Narrator reads held facts word for word up front and the rest with the state", () => {
  const prompt = assemblePrompt({
    save: { worldBrief: "A drowned city", pc: { name: "Ash" }, startingHook: "" },
    state: stateWith(["Held fact.", "New fact."], ["Held fact.", "Fact the player took off."]),
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
  expect(prompt[0]!.content).not.toContain("Fact the player took off.");
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
    held: ["Old fact."],
  };
  const next = applyEdit(applyEdit(state, fold), fold);

  expect(next.npcKnows).toEqual({ Wren: ["Summary.", "New."] });
  expect(next.heldFacts).toEqual(["Old fact."]);
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
