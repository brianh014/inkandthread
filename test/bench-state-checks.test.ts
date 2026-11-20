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

test("a knows entry repeating one in other words counts once when it arrives", () => {
  const faults = stateFaults([
    {
      action: "choice",
      before: state({ npcKnows: { Kit: ["Nell saw the lantern in the cellar."] } }),
      after: state({ npcKnows: { Kit: ["Nell saw the lantern in the cellar.", "Nell has seen the lantern in the cellar", "The bell rang at noon."] } }),
    },
  ]);
  expect(faults["stateFaults.repeatKnows"]).toBe(1);
});

test("a correction or a fact sharing a word or two is no repeat", () => {
  const was = state({ npcKnows: { Kit: ["Thorne's brother is alive and hiding."] } });
  const now = (fact: string) => state({ npcKnows: { Kit: ["Thorne's brother is alive and hiding.", fact] } });
  for (const fact of ["Thorne's brother is not alive and hiding.", "Thorne's brother keeps the inn."])
    expect(stateFaults([{ action: "choice", before: was, after: now(fact) }])["stateFaults.repeatKnows"]).toBe(0);
});

test("repeats and negatives the app turned away still count, from its ignored operations", () => {
  const faults = stateFaults([], ["npc_learns: already there", "npc_learns: only what they don't know", "add_loose_end: already there"]);
  expect(faults["stateFaults.repeatKnows"]).toBe(1);
  expect(faults["stateFaults.negativeKnows"]).toBe(1);
  expect(faults["stateFaults.total"]).toBe(2);
});

test("a Loose End resolved and then back on a Turn counts as reopened, but not when an Edit brings it back", () => {
  const open = state({ looseEnds: ["Who rang the bell?"] });
  const closed = state({ looseEnds: [] });
  const reopened = (action: string) =>
    stateFaults([
      { action: "choice", before: open, after: closed },
      { action, before: closed, after: open },
    ])["stateFaults.looseEndReopened"];
  expect(reopened("choice")).toBe(1);
  expect(reopened("edit")).toBe(0);
});
