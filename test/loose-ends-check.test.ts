import { expect, test } from "bun:test";
import { CHECK_FACTS, CHECK_LOOSE_ENDS, closeLooseEnds, settledOf } from "../src/loose-ends-check";
import type { SaveStore } from "../src/save-store";
import { applyEdit, openingState, type State, type WorldEdit } from "../src/state-applier";
import { scriptedTextProvider } from "./support";

const ends = (count: number) => Array.from({ length: count }, (_, at) => `Loose end ${at}.`);
const signal = new AbortController().signal;

/** Just what the check reads and writes of a Save. */
const savesWith = (state: State) => {
  const changes: WorldEdit[][] = [];
  const saves = {
    latestMessageId: () => 7,
    latestState: () => state,
    messages: () => [{ id: 7, role: "narrator", text: "Ash keeps the promise." }],
    pendingEdits: () => [],
    addWorldChange: (_id: string, _on: number, edits: WorldEdit[]) => changes.push(edits),
  };
  return { saves: saves as unknown as SaveStore, changes };
};

test("a reply's numbers name each Loose End once, none past the list and none the player just wrote", () => {
  expect(settledOf(ends(12), [1, 1, 3, 0, 13, 5], ["Loose end 4."])).toEqual({ named: 3, settled: ["Loose end 0.", "Loose end 2."] });
});

test("a pause closes at most a quarter of the Loose Ends, the first named first, and none when a reply names over half", () => {
  expect(settledOf(ends(12), [4, 1, 2, 3]).settled).toEqual(["Loose end 3.", "Loose end 0.", "Loose end 1."]);
  expect(settledOf(ends(12), [1, 2, 3, 4, 5, 6, 7])).toEqual({ named: 7, settled: [] });
});

test("the pause closes what the Scribe found settled, asks nothing with few open, and a failure closes none", async () => {
  const state = { ...structuredClone(openingState), looseEnds: ends(CHECK_LOOSE_ENDS) };
  const checked = savesWith(state);
  await closeLooseEnds(scriptedTextProvider(JSON.stringify({ settled: [2] })).textProvider, checked.saves, "save", signal);

  const [[edit]] = checked.changes as [[WorldEdit]];
  expect(edit).toMatchObject({ moved: true, settled: ["Loose end 1."] });
  expect(applyEdit(state, edit).looseEnds).not.toContain("Loose end 1.");

  const few = scriptedTextProvider();
  await closeLooseEnds(few.textProvider, savesWith({ ...state, looseEnds: ends(CHECK_LOOSE_ENDS - 1) }).saves, "save", signal);
  expect(few.prompts).toHaveLength(0);

  const failed = savesWith(state);
  await closeLooseEnds(scriptedTextProvider(new Error("down")).textProvider, failed.saves, "save", signal);
  expect(failed.changes).toHaveLength(0);
});

test("a pause drops at most a tenth of a long list of known facts, in the same call, and only once there are many", async () => {
  const facts = Array.from({ length: CHECK_FACTS }, (_, at) => `Fact ${at}.`);
  const state = { ...structuredClone(openingState), pcKnown: { ...openingState.pcKnown, facts } };
  const checked = savesWith(state);
  const script = scriptedTextProvider(JSON.stringify({ outdated: [2, 4, 6, 8, 10] }));
  await closeLooseEnds(script.textProvider, checked.saves, "save", signal);

  const [[edit]] = checked.changes as [[WorldEdit]];
  expect(edit).toMatchObject({ moved: true, outdated: ["Fact 1.", "Fact 3.", "Fact 5."] });
  expect(applyEdit(state, edit).pcKnown.facts).toHaveLength(CHECK_FACTS - 3);
  // Nothing of the Loose Ends, which are few, and the facts first, for the cache.
  const [system, user] = script.prompts[0]!;
  expect(system!.content).not.toContain("In settled");
  expect(Object.keys(JSON.parse(user!.content))).toEqual(["known_facts", "summary", "latest_replies"]);

  const both = scriptedTextProvider(JSON.stringify({ settled: [1], outdated: [] }));
  await closeLooseEnds(both.textProvider, savesWith({ ...state, looseEnds: ends(CHECK_LOOSE_ENDS) }).saves, "save", signal);
  expect(both.prompts).toHaveLength(1);
  expect(both.prompts[0]![0]!.content).toContain("In settled");

  const few = scriptedTextProvider();
  await closeLooseEnds(few.textProvider, savesWith({ ...state, pcKnown: { ...state.pcKnown, facts: facts.slice(1) } }).saves, "save", signal);
  expect(few.prompts).toHaveLength(0);
});
