import { expect, test } from "bun:test";
import { stateFaults } from "../bench/state-checks";
import type { State } from "../src/state-applier";

const state = (fields: Partial<State>) => ({ storyTime: null, npcKnows: {}, looseEnds: [], ...fields }) as State;
const at = (day: number, timeOfDay: string) => ({ day, date: "Monday", timeOfDay });

test("story time going back on a Turn counts, but not on a Rewrite", () => {
  const back = { before: state({ storyTime: at(2, "evening") }), after: state({ storyTime: at(2, "morning") }) };
  expect(stateFaults([{ action: "choice", ...back }])["stateFaults.timeBack"]).toBe(1);
  expect(stateFaults([{ action: "rewrite", ...back }])["stateFaults.timeBack"]).toBe(0);
  const forward = { before: state({ storyTime: at(2, "night") }), after: state({ storyTime: at(3, "dawn") }) };
  expect(stateFaults([{ action: "choice", ...forward }])["stateFaults.timeBack"]).toBe(0);
});

test("a repeated or negative knows entry counts once when it arrives", () => {
  const faults = stateFaults([
    {
      action: "choice",
      before: state({ npcKnows: { Kit: ["The ledger is gone."] } }),
      after: state({ npcKnows: { Kit: ["The ledger is gone.", "the ledger is gone", "Kit has not heard of the letter."] } }),
    },
  ]);
  expect(faults["stateFaults.repeatKnows"]).toBe(1);
  expect(faults["stateFaults.negativeKnows"]).toBe(1);
  expect(faults["stateFaults.total"]).toBe(2);
});

test("a Loose End resolved and then back counts as reopened", () => {
  const open = state({ looseEnds: ["Who rang the bell?"] });
  const closed = state({ looseEnds: [] });
  expect(
    stateFaults([
      { action: "choice", before: open, after: closed },
      { action: "edit", before: closed, after: open },
    ])["stateFaults.looseEndReopened"],
  ).toBe(1);
});
