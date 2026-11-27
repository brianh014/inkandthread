import { expect, test } from "bun:test";
import { applyOperations, openingState, type State } from "../src/state-applier";

const dressed: State = {
  ...openingState,
  inventory: { wearing: ["black uniform boots", "science-blue tunic"], carrying: ["a notebook"] },
  scene: { location: "Sorrell's quarters", visibleCast: ["Sorrell"] },
  npcs: [{ name: "Sorrell", appearance: "a tall woman with wiry red-brown hair, in a science-blue uniform tunic and black boots" }],
};

test("what the PC takes off is set aside with where, and comes back in its own words and slot", () => {
  const off = applyOperations(dressed, [{ op: "remove_item", item: "black uniform boots" }]).next;
  expect(off.inventory.wearing).toEqual(["science-blue tunic"]);
  expect(off.inventory.setAside).toEqual([{ item: "black uniform boots", slot: "wearing", place: "Sorrell's quarters" }]);
  // Put back on as carried and in fewer words, it is still the same boots, worn.
  const on = applyOperations(off, [{ op: "add_item", slot: "carrying", item: "uniform boots" }]).next;
  expect(on.inventory.wearing).toEqual(["science-blue tunic", "black uniform boots"]);
  expect(on.inventory.carrying).toEqual(["a notebook"]);
  expect(on.inventory.setAside).toEqual([]);
});

test("a thing that isn't the one set aside is added as it is, and the set-aside list keeps only the newest", () => {
  const off = applyOperations(dressed, [{ op: "remove_item", item: "science-blue tunic" }]).next;
  const other = applyOperations(off, [{ op: "add_item", slot: "wearing", item: "a grey work shirt" }]).next;
  expect(other.inventory.wearing).toEqual(["black uniform boots", "a grey work shirt"]);
  expect(other.inventory.setAside).toHaveLength(1);
  const many = applyOperations(
    { ...dressed, inventory: { wearing: [], carrying: Array.from({ length: 10 }, (_, at) => `pebble number ${at}`) } },
    Array.from({ length: 10 }, (_, at) => ({ op: "remove_item" as const, item: `pebble number ${at}` })),
  ).next;
  expect(many.inventory.setAside?.map(({ item }) => item)).toEqual(Array.from({ length: 8 }, (_, at) => `pebble number ${at + 2}`));
});

test("an NPC's looks before a change dropped part of them are kept until most of them are back", () => {
  const undressed = applyOperations(dressed, [
    { op: "update_npc", name: "Sorrell", appearance: "a tall woman with wiry red-brown hair, barefoot", portrait: false },
  ]).next;
  const was = dressed.npcs[0]!.appearance;
  expect(undressed.npcs[0]!.was).toBe(was);
  // A second change keeps the first looks, as they are what goes back on.
  const more = applyOperations(undressed, [
    { op: "update_npc", name: "Sorrell", appearance: "a tall woman with wiry red-brown hair, nude", portrait: false },
  ]).next;
  expect(more.npcs[0]!.was).toBe(was);
  const back = applyOperations(more, [{ op: "update_npc", name: "Sorrell", appearance: was, portrait: false }]).next;
  expect(back.npcs[0]!.was).toBeUndefined();
  // A rewording of a word or two keeps nothing.
  const reworded = applyOperations(dressed, [
    {
      op: "update_npc",
      name: "Sorrell",
      appearance: "a tall woman with wiry red-brown hair, in a science-blue uniform tunic and black shoes",
      portrait: false,
    },
  ]).next;
  expect(reworded.npcs[0]!.was).toBeUndefined();
});
