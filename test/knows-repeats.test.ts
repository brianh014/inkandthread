import { expect, test } from "bun:test";
import { alike, applyEdit, applyOperations, openingState, type State } from "../src/state-applier";

const OLD = "Nell told him the candle stub matched the tallow in Crane's cuff.";
const AGAIN = "Nell told him the candle stub matched the tallow found in Crane's cuff.";
const empty = { lore_entries: [], removed_lore: [], world_rules: [], plot_threads: [] };
const withKit = (knows: string[], parts: string[] = []): State => ({
  ...structuredClone(openingState),
  npcs: [{ name: "Kit", appearance: "a boy in a cap" }],
  npcKnows: { Kit: knows },
  npcParts: parts.length > 0 ? { Kit: parts } : {},
});

test("the same fact in other words is alike, but its denial and another fact are not", () => {
  expect(alike(OLD, AGAIN)).toBe(true);
  expect(alike(OLD, "Nell told him the candle stub never matched the tallow in Crane's cuff.")).toBe(false);
  expect(alike(OLD, "Kit saw the lantern go down to the fish house.")).toBe(false);
});

test("what someone learns again in other words replaces what they knew, where it stood", () => {
  const { next, refused } = applyOperations(withKit([OLD, "Kit hides in the loft."]), [{ op: "npc_learns", name: "Kit", fact: AGAIN }]);

  expect(refused).toEqual([]);
  expect(next.npcKnows.Kit).toEqual([AGAIN, "Kit hides in the loft."]);
});

test("a part World Moves On gives again in other words replaces the old part and entry", () => {
  const next = applyEdit(withKit([OLD], [OLD]), { edit: "world", update: empty, moved: true, knows: { Kit: [AGAIN] }, parts: {} });

  expect(next.npcKnows.Kit).toEqual([AGAIN]);
});
