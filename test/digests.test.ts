import { expect, test } from "bun:test";
import { digestFacts, FOLD_FACTS, factsDue, foldKnows, KEEP_KNOWS, knowsDue, RECENT_FACTS } from "../src/digests";
import { assemblePrompt } from "../src/prompt-assembler";
import type { SaveStore } from "../src/save-store";
import { applyEdit, FOLD_NPC_KNOWS, openingState, type State, type WorldEdit } from "../src/state-applier";
import { scriptedTextProvider } from "./support";

const facts = (count: number) => Array.from({ length: count }, (_, at) => `Fact ${at}.`);
const withFacts = (list: string[], covered: string[] = []) => ({ pcKnown: { facts: list, npcs: [] }, factsDigest: { text: "Old digest.", covered } });
const empty = { lore_entries: [], removed_lore: [], world_rules: [], plot_threads: [] };

test("facts fold only once enough have aged past the newest, never the newest or those already covered", () => {
  expect(factsDue(withFacts(facts(RECENT_FACTS + FOLD_FACTS - 1)))).toBeNull();

  const list = facts(RECENT_FACTS + FOLD_FACTS + 10);
  const due = factsDue(withFacts(list, list.slice(0, 10)))!;

  expect(due.batch).toEqual(list.slice(10, -RECENT_FACTS));
  expect(due.kept).toEqual(list.slice(0, 10));
  expect(due.dropped).toEqual([]);
});

test("a covered fact the player changed is dropped from the digest and its new words folded", () => {
  const list = facts(RECENT_FACTS + FOLD_FACTS + 5);
  const covered = list.slice(0, 5);
  list[2] = "Fact two, as the player wrote it.";
  const due = factsDue(withFacts(list, covered))!;

  expect(due.dropped).toEqual(["Fact 2."]);
  expect(due.kept).not.toContain("Fact 2.");
  expect(due.batch).toContain("Fact two, as the player wrote it.");
});

test("what someone knows folds past the limit, keeping their newest and never their parts", () => {
  const knows = [...facts(FOLD_NPC_KNOWS), "Their part."];
  const due = knowsDue({ npcKnows: { Wren: knows, Short: facts(3) }, npcParts: { Wren: ["Their part."] } });

  expect(Object.keys(due)).toEqual(["Wren"]);
  expect(due.Wren).toEqual(facts(FOLD_NPC_KNOWS).slice(0, -KEEP_KNOWS));
});

test("a fold puts its summary first, in place of the entries it stands for, and a digest replaces the last", () => {
  const state: State = { ...structuredClone(openingState), npcKnows: { Wren: ["Old a.", "Old b.", "New."] } };
  const next = applyEdit(state, {
    edit: "world",
    update: empty,
    moved: true,
    folded: { Wren: { knew: ["Old a.", "Old b."], into: "Summary." }, Gone: { knew: [], into: "Never met." } },
    digest: { text: "Digest.", covered: ["Old fact."] },
  });

  expect(next.npcKnows).toEqual({ Wren: ["Summary.", "New."] });
  expect(next.factsDigest).toEqual({ text: "Digest.", covered: ["Old fact."] });
});

test("the Narrator reads the digest up front and only the facts it doesn't cover with the state", () => {
  const prompt = assemblePrompt({
    save: { worldBrief: "A drowned city", pc: { name: "Ash" }, startingHook: "" },
    state: { ...structuredClone(openingState), ...withFacts(["Covered fact.", "Uncovered fact.", "New fact."], ["Covered fact."]) },
    messages: [],
    modelInstructions: "",
    input: "I wait.",
    responseSchema: "{}",
    promptStyle: null,
  });
  const latest = prompt
    .slice(1)
    .map(({ content }) => content)
    .join("\n");

  expect(prompt[0]!.content).toContain("Old digest.");
  expect(latest).not.toContain("Covered fact.");
  expect(latest).toContain("Uncovered fact.");
  expect(latest).toContain("New fact.");
});

/** Just what the digests read and write of a Save. */
const savesWith = (state: State) => {
  const changes: WorldEdit[][] = [];
  const saves = { latestMessageId: () => 7, latestState: () => state, addWorldChange: (_id: string, _on: number, edits: WorldEdit[]) => changes.push(edits) };
  return { saves: saves as unknown as SaveStore, changes };
};

test("the Scribe's digest and folds reach the Save as a hidden World Change, and a failed call changes nothing", async () => {
  const list = facts(RECENT_FACTS + FOLD_FACTS);
  const state: State = { ...structuredClone(openingState), pcKnown: { facts: list, npcs: [] }, npcKnows: { Wren: facts(FOLD_NPC_KNOWS + 1), Other: facts(2) } };
  const { saves, changes } = savesWith(state);
  const scribe = scriptedTextProvider(
    JSON.stringify({ digest: "Wren: all of it." }),
    JSON.stringify({
      people: [
        { name: "Wren", summary: "Wren knows the old facts." },
        { name: "Stranger", summary: "Not asked." },
      ],
    }),
    new Error("down"),
  );
  const signal = new AbortController().signal;

  await digestFacts(scribe.textProvider, saves, "save", signal);
  await foldKnows(scribe.textProvider, saves, "save", signal);
  await digestFacts(scribe.textProvider, saves, "save", signal);

  const [[digest], [fold]] = changes as [[WorldEdit], [WorldEdit]];
  expect(changes).toHaveLength(2);
  expect(digest).toMatchObject({ moved: true, digest: { text: "Wren: all of it.", covered: list.slice(0, FOLD_FACTS) } });
  expect(fold).toMatchObject({ folded: { Wren: { knew: facts(FOLD_NPC_KNOWS + 1).slice(0, -KEEP_KNOWS), into: "Wren knows the old facts." } } });
  expect(Object.keys((fold as { folded: object }).folded)).toEqual(["Wren"]);
});

test("a fact the player took off the digest's facts asks for a fold at once, with no batch due", () => {
  const list = facts(RECENT_FACTS + 5);
  const due = factsDue(withFacts(list.slice(1), list.slice(0, 5)))!;

  expect(due.dropped).toEqual(["Fact 0."]);
  expect(due.batch).toEqual([]);
});
