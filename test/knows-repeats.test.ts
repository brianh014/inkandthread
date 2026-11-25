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
  expect(alike("Kit saw Ann take the ledger from the chapel.", "Kit saw Tom take the ledger from the chapel.")).toBe(false);
  expect(alike("Crane paid Nell to burn the mill down.", "Nell paid Crane to burn the mill down.")).toBe(false);
});

test("what someone learns again in other words replaces what they knew as the newest, and stays a part if it was one", () => {
  const { next, refused } = applyOperations(withKit([OLD, "Kit hides in the loft."], [OLD]), [{ op: "npc_learns", name: "Kit", fact: AGAIN }]);

  expect(refused).toEqual([]);
  expect(next.npcKnows.Kit).toEqual(["Kit hides in the loft.", AGAIN]);
  expect(next.npcParts.Kit).toEqual([AGAIN]);
});

test("a part World Moves On gives again in other words replaces the old part and entry", () => {
  const next = applyEdit(withKit([OLD], [OLD]), { edit: "world", update: empty, moved: true, knows: { Kit: [AGAIN] }, parts: {} });

  expect(next.npcKnows.Kit).toEqual([AGAIN]);
  expect(next.npcParts.Kit).toEqual([AGAIN]);
});

test("a move's part that mostly says an old one replaces it, and one an old part says whole isn't added", () => {
  const old = "He let the autumn tanker leave half-unloaded to save a day and knows the tank runs dry Wednesday night.";
  const newer = "He is in the generator hut and knows the tank runs dry Wednesday night, that he let the autumn tanker leave half-unloaded to save a day.";
  const state = {
    ...structuredClone(openingState),
    npcs: [{ name: "Kit", appearance: "a boy" }],
    plotThreads: ["The fuel runs out."],
    npcKnows: { Kit: [old] },
    npcParts: { Kit: [old] },
  };
  const give = (from: typeof state, part: string) =>
    applyEdit(from, {
      edit: "world",
      update: { lore_entries: [], removed_lore: [], world_rules: [], plot_threads: [] },
      made: 0,
      moved: true,
      knows: { Kit: [part] },
      parts: { "The fuel runs out.": ["Kit"] },
    });

  const replaced = give(state, newer);
  expect([replaced.npcKnows.Kit, replaced.npcParts.Kit]).toEqual([[newer], [newer]]);

  const again = give(replaced as typeof state, "He knows the tank runs dry Wednesday night, in the hut.");
  expect(again.npcKnows.Kit).toEqual([newer]);
  // A different part stays beside it.
  const other = "Pavel keeps a flare pistol under the bunk and drinks the medical alcohol.";
  expect(give(state, other).npcKnows.Kit).toEqual([old, other]);
});
