import { expect, test } from "bun:test";
import { bestOnAllThree, type ChartResult, chartPage, costFrontier, type Point, points } from "../bench/chart";

const run = (narrator: string, scores: number[], cost: number, extra: Partial<ChartResult> = {}): ChartResult => ({
  version: 1,
  setup: "narrator",
  provider: "openrouter",
  models: { narrator, reviewer: narrator, consistency: "off" },
  judge: { plays: scores.map((score) => ({ scores: { a: { score }, b: { score } } })) },
  plays: scores.map(() => ({ "cost.total": cost * 10, turns: 10, "timing.turn.median": 30_000, "timing.firstText.median": 10_000 })),
  ...extra,
});

test("several runs of a setup pool their plays into one point; other versions, unjudged runs and setups apart", () => {
  const found = points(
    [
      run("x/mimo", [6, 8], 0.01),
      run("x/mimo", [7], 0.02),
      run("x/mimo", [9], 0.01, { version: 0 }),
      run("x/mimo", [9], 0.01, { judge: null }),
      run("x/mimo", [5], 0.05, { setup: "full", models: { narrator: "x/mimo", reviewer: "y/flash", consistency: "z/d1" } }),
    ],
    1,
  );
  expect(found).toHaveLength(2);
  const alone = found.find((p) => p.setup === "narrator")!;
  expect(alone).toMatchObject({ label: "mimo", score: 7, low: 6, high: 8, runs: 2, plays: 3 });
  expect(alone.cost).toBeCloseTo(0.04 / 3);
  expect(found.find((p) => p.setup === "full")!.label).toBe("mimo · flash · d1");
});

const point = (label: string, score: number, cost: number, turnMs = 30_000): Point => ({
  setup: "narrator",
  label,
  score,
  low: score,
  high: score,
  cost,
  turnMs,
  firstMs: 0,
  runs: 1,
  plays: 1,
});

test("the frontier keeps the setups no other beats on both score and cost, cheapest first", () => {
  const all = [point("dear-best", 9, 1), point("cheap", 6, 0.01), point("beaten", 5, 0.1), point("middle", 8, 0.1)];
  expect(costFrontier(all).map((p) => p.label)).toEqual(["cheap", "middle", "dear-best"]);
});

test("a setup beaten on score and cost still counts on all three when it is the fastest", () => {
  const fast = point("fast", 7, 0.1, 10_000);
  const all = [fast, point("better", 8, 0.05, 40_000), point("worse", 6, 0.2, 50_000)];
  expect(bestOnAllThree(fast, all)).toBe(true);
  expect(bestOnAllThree(all[2]!, all)).toBe(false);
});

test("the page escapes model names and says when a chart has no runs", () => {
  const page = chartPage([point("<b>", 7, 0.01)], 1);
  expect(page).toContain("&lt;b&gt;");
  expect(page).toContain("No judged, kept runs");
});
