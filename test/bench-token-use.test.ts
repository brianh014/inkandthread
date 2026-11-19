import { expect, test } from "bun:test";
import { type Call, tokenTable, tokenUse } from "../bench/token-use";

const call = (role: string, step: number, use: Partial<Call>): Call => ({ role, step, ms: 0, in: 0, cached: 0, out: 0, reasoning: 0, cost: 0, ...use });

test("the bench counts each kind of call's tokens and cost, and the median a Turn spends, over all calls too", () => {
  const calls = [
    call("narrator.turn", 0, { in: 1000, cached: 800, out: 300, reasoning: 100, cost: 0.01 }),
    call("narrator.turn", 1, { in: 1200, cached: 900, out: 350, reasoning: 150, cost: 0.012 }),
    // A retry in the same Turn counts towards it.
    call("narrator.turn", 1, { in: 1200, out: 50, cost: 0.002 }),
    call("reviewer.upkeep", 1, { in: 500, out: 40, cost: 0.001 }),
    call("narrator.turn", 2, { in: 1400, cached: 1000, out: 400, reasoning: 200, cost: 0.014 }),
    // Not a Turn's step, such as a World Change, so it counts in the totals and in no Turn.
    call("narrator.worldChange", 3, { in: 900, out: 90, cost: 0.003 }),
  ];

  const use = tokenUse(calls, [0, 1, 2]);

  expect(use["calls.narrator.turn"]).toBe(4);
  expect(use["tokens.narrator.turn.in"]).toBe(4800);
  expect(use["tokens.narrator.turn.cached"]).toBe(2700);
  expect(use["tokens.narrator.turn.reasoning"]).toBe(450);
  expect(use["cost.narrator.turn"]).toBeCloseTo(0.038);
  expect(use["tokens.narrator.turn.perTurn.in"]).toBe(1400);
  // Upkeep ran in one Turn of three, so a Turn's median is none.
  expect(use["tokens.reviewer.upkeep.perTurn.in"]).toBe(0);
  expect(use["calls.narrator.worldChange"]).toBe(1);
  expect(use["tokens.narrator.worldChange.perTurn.in"]).toBe(0);
  expect(use["tokens.perTurn.in"]).toBe(1400);
  expect(use["tokens.perTurn.out"]).toBe(400);

  const table = tokenTable(use);
  expect(table.split("\n")[1]).toStartWith("  narrator.turn");
  expect(table).toContain("per Turn (median, all calls)");
});
