import { expect, test } from "bun:test";
import { restyledBy } from "../src/image-pipeline";
import { applyOperations, isBody, openingState, type State } from "../src/state-applier";

// Someone killed in play is marked dead, so no one paints, plans for or asks a part of them (ticket 109).
const withState = (sections: Partial<State> = {}): State => ({
  ...structuredClone(openingState),
  npcs: [
    { name: "Arne Vik", appearance: "A big fair-bearded man." },
    { name: "Lise Moen", appearance: "A small woman with a braid." },
  ],
  ...sections,
});

test("a death the narration shows is kept under the state's own name, and a stranger's is passed over, never refused", () => {
  const { next, refused, ignored } = applyOperations(withState(), [
    { op: "npc_dies", name: "Vik" },
    { op: "npc_dies", name: "A guard" },
  ]);

  expect(next.dead).toEqual(["Arne Vik"]);
  expect(isBody(next, "Arne Vik")).toBe(true);
  expect(isBody(next, "Lise Moen")).toBe(false);
  expect(refused).toEqual([]);
  expect(ignored).toHaveLength(1);
});

test("the dead keep their death through a merge, and their portrait is never redrawn for a death wound", () => {
  const dead = applyOperations(withState(), [{ op: "npc_dies", name: "Arne Vik" }]).next;
  const merged = applyOperations(dead, [{ op: "merge_npc", name: "Arne Vik", into: "Arne" }]).next;
  expect(merged.dead).toEqual(["Arne"]);

  const wounded = applyOperations(dead, [{ op: "update_npc", name: "Arne Vik", appearance: "A big fair-bearded man, his throat cut.", portrait: true }]).next;
  expect(restyledBy(dead, wounded)).toEqual([]);
});
