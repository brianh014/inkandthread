import { expect, test } from "bun:test";
import { ALL_STORIES, bestOnAllThree, type ChartResult, chartPage, costFrontier, type Point, points } from "../bench/chart";

const run = (narrator: string, scores: number[], cost: number, extra: Partial<ChartResult> = {}): ChartResult => ({
  version: "0.5.0.1",
  setup: "narrator",
  rounds: 30,
  drawn: true,
  provider: "openrouter",
  thinking: "medium",
  models: { narrator, reviewer: narrator, reviewThinking: "same", consistency: "off" },
  judge: { plays: scores.map((score) => ({ scores: { a: { score }, b: { score } } })) },
  plays: scores.map(() => ({ "cost.total": cost * 10, turns: 10, "timing.turn.median": 30_000, "timing.firstText.median": 10_000 })),
  ...extra,
});

test("several runs of a setup pool their plays into one point; unlike or unjudged runs are left out", () => {
  const found = points(
    [
      run("x/mimo", [6, 8], 0.01),
      run("x/mimo", [7], 0.02),
      run("x/mimo", [9], 0.01, { version: "0.5.0.0" }),
      run("x/mimo", [9], 0.01, { judge: null }),
      run("x/mimo", [9], 0.01, { rounds: 20 }),
      run("x/mimo", [9], 0.01, { mode: "free text: moves.txt" }),
      run("x/mimo", [9], 0.01, { world: "adult.json" }),
      run("x/mimo", [9], 0.01, { drawn: false }),
      run("x/mimo", [5], 0.05, { setup: "full", models: { narrator: "x/mimo", reviewer: "y/flash", reviewThinking: "medium", consistency: "z/d1" } }),
    ],
    "0.5.0.1",
    30,
  );
  expect(found).toHaveLength(2);
  const alone = found.find((p) => p.setup === "narrator")!;
  expect(alone).toMatchObject({ label: "mimo", score: 7, low: 6, high: 8, runs: 2, plays: 3 });
  expect(alone.cost).toBeCloseTo(0.04 / 3);
  expect(found.find((p) => p.setup === "full")!.label).toBe("mimo · flash · d1");
});

test("the same short name from another vendor, or at another Thinking, is a setup of its own", () => {
  const found = points([run("x/mimo", [6], 0.01), run("y/mimo", [7], 0.01), run("x/mimo", [8], 0.01, { thinking: "high" })], "0.5.0.1", 30);
  expect(found).toHaveLength(3);
});

const point = (label: string, score: number, cost: number, turnMs = 30_000): Point => ({
  setup: "narrator",
  label,
  detail: label,
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

test("the page escapes model names, and each setup is picked with the Setup selector, saying when it has no runs", () => {
  const page = chartPage([run("x/<b>", [7], 0.01)], 30);
  expect(page).toContain("&lt;b&gt;");
  // Narrator-only runs alone: that chart shows, and the other setup's waits hidden with its empty message.
  expect(page).toContain('<div data-setup="narrator">');
  expect(page).toContain('<div data-setup="full" hidden>');
  expect(page).toContain("No judged, kept runs");
  expect(page).toContain(">Narrator only</option>");
});

test("a setup with no cost recorded is named under the chart, not drawn on the log scale", () => {
  const page = chartPage([run("x/priced", [7], 0.01), run("x/local", [6], 0)], 30);
  expect(page).toContain("No cost recorded, so not drawn: openrouter x/local, Thinking medium.");
  expect(page).not.toContain("NaN");
});

test("the page has a view for every version, score and story, newest version, the overall and all stories shown first", () => {
  const page = chartPage(
    [run("x/mimo", [7], 0.01), run("x/mimo", [8], 0.01, { version: "0.5.0.12" }), run("x/mimo", [6], 0.01, { world: "horror.json" })],
    30,
    {
      titles: { "horror.json": "Horror" },
    },
  );
  // Two versions, all stories plus two, and the overall plus items a and b.
  expect(page.match(/class="view"/g)).toHaveLength(2 * 3 * 3);
  expect(page).toContain('<div class="view" data-version="0.5.0.12" data-world="all" data-score="overall">');
  expect(page.match(/class="view"[^>]*hidden/g)).toHaveLength(2 * 3 * 3 - 1);
  expect(page).toContain(">All stories</option>");
  expect(page).toContain(">Horror</option>");
});

test("all stories pools every story's plays into one point", () => {
  const found = points([run("x/mimo", [8], 0.01), run("x/mimo", [6], 0.01, { world: "horror.json" })], "0.5.0.1", 30, ALL_STORIES);
  expect(found[0]).toMatchObject({ score: 7, low: 6, high: 8, runs: 2, plays: 2 });
});

test("one rubric item can be charted alone, and a play judged without it is left out", () => {
  const judged = run("x/mimo", [7], 0.01);
  judged.judge!.plays[0]!.scores.c = { score: 3 };
  expect(points([judged], "0.5.0.1", 30, "adventure.json", "c")[0]!.score).toBe(3);
  expect(points([judged], "0.5.0.1", 30, "adventure.json", "overall")[0]!.score).toBeCloseTo(17 / 3);
  expect(points([run("x/mimo", [7], 0.01)], "0.5.0.1", 30, "adventure.json", "c")).toHaveLength(0);
});

test("a genre score can be charted on its own, and stays out of the overall", () => {
  const judged = run("x/mimo", [7], 0.01);
  judged.judge!.plays[0]!.genres = { romance: { score: 2 } };
  expect(points([judged], "0.5.0.1", 30, "adventure.json", "romance")[0]!.score).toBe(2);
  expect(points([judged], "0.5.0.1", 30, "adventure.json", "overall")[0]!.score).toBe(7);
  expect(chartPage([judged], 30)).toContain(">Romance</option>");
});

test("the picker offers every score the bench asks, even one no kept run has yet", () => {
  const page = chartPage([run("x/mimo", [7], 0.01)], 30, { scores: ["a", "b", "spiciness"] });
  expect(page).toContain(">Spiciness</option>");
  expect(page).toContain('data-score="spiciness"');
});
