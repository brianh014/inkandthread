import { expect, test } from "bun:test";
import { foldKnows, KEEP_KNOWS, knowsDue } from "../src/knowledge-folds";
import type { SaveStore } from "../src/save-store";
import { applyEdit, FOLD_NPC_KNOWS, openingState, type State, type WorldEdit } from "../src/state-applier";
import { scriptedTextProvider } from "./support";

const facts = (count: number) => Array.from({ length: count }, (_, at) => `Fact ${at}.`);
const empty = { lore_entries: [], removed_lore: [], world_rules: [], plot_threads: [] };
const signal = new AbortController().signal;

/** Just what the pause reads and writes of a Save. */
const savesWith = (state: State) => {
  const changes: WorldEdit[][] = [];
  const saves = { latestMessageId: () => 7, latestState: () => state, addWorldChange: (_id: string, _on: number, edits: WorldEdit[]) => changes.push(edits) };
  return { saves: saves as unknown as SaveStore, changes };
};

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
  };
  const next = applyEdit(applyEdit(state, fold), fold);

  expect(next.npcKnows).toEqual({ Wren: ["Summary.", "New."] });
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

test("a fold's summary is cleaned as a learned fact is, and one with nothing left folds no one", async () => {
  const { saves, changes } = savesWith({ ...structuredClone(openingState), npcKnows: { Wren: facts(FOLD_NPC_KNOWS + 1), Ada: facts(FOLD_NPC_KNOWS + 1) } });
  const scribe = scriptedTextProvider(
    JSON.stringify({
      people: [
        { name: "Wren", summary: "Wren saw the ledger burn +#+#+#" },
        { name: "Ada", summary: "Ada has not heard of the ledger." },
      ],
    }),
  );

  await foldKnows(scribe.textProvider, saves, "save", signal);

  expect(Object.keys((changes[0]![0] as { folded: object }).folded)).toEqual(["Wren"]);
  expect(changes[0]![0]).toMatchObject({ folded: { Wren: { into: "Wren saw the ledger burn" } } });
});
