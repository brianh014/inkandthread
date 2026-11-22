import { expect, test } from "bun:test";
import { CHECK_LOOSE_ENDS, closeLooseEnds, settledOf } from "../src/loose-ends-check";
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
    addWorldChange: (_id: string, _on: number, edits: WorldEdit[]) => changes.push(edits),
  };
  return { saves: saves as unknown as SaveStore, changes };
};

test("a reply's numbers name each Loose End once, and none past the list", () => {
  expect(settledOf(ends(12), [1, 1, 3, 0, 13])).toEqual(["Loose end 0.", "Loose end 2."]);
});

test("a reply closing more than a quarter of the Loose Ends closes none", () => {
  expect(() => settledOf(ends(12), [1, 2, 3, 4])).toThrow("closed 4 of 12");
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
