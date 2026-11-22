// `bun bench chart`: the kept runs as two charts, judged score against cost per Turn, coloured by Turn time, one for the Narrator
// alone and one for the Narrator with a Scribe. A self-contained page whose one small script picks the bench
// version, the score (overall or one rubric item) and the story to show; every pick is drawn up front.

/** The parts of a bench result the chart reads (bench.ts's `Result`). */
export type ChartResult = {
  version?: string | number;
  setup?: "narrator" | "full";
  rounds: number;
  mode?: string;
  world?: string;
  drawn?: boolean;
  provider: string;
  thinking: string;
  /** `consistency` only on runs from before the Consistency check was removed. */
  models: { narrator: string; reviewer: string; reviewThinking: string; consistency?: string };
  /** Each play's rubric items, which make the overall, and its genre scores (romance, horror and the like), asked only of a story of that kind. */
  // `overall` is given from the second rubric on, when caps and a penalty for mistakes make it more than the items' mean.
  judge: { plays: { scores: Record<string, { score: number }>; genres?: Record<string, { score: number }>; overall?: number }[] } | null;
  plays: Record<string, number>[];
  /** The rubric it was judged by; absent before the second. */
  rubric?: number;
  /** Set on a run played on from a kept story, which charts never set beside one from a story's start. */
  continued?: { from: string };
};

export type Point = {
  setup: "narrator" | "full";
  label: string;
  /** The full model ids, provider and Thinking, which tell apart setups whose short labels match. */
  detail: string;
  /** Judged overall score, the mean over every play, and its lowest and highest play. */
  score: number;
  low: number;
  high: number;
  /** Dollars per Turn. */
  cost: number;
  turnMs: number;
  firstMs: number;
  runs: number;
  plays: number;
};

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const short = (model: string) => model.split("/").pop() || model;

/** The overall score, or one rubric item's; and every story pooled, or one. */
export const OVERALL = "overall";
export const ALL_STORIES = "all";

/**
 * One point per setup, from every judged result of `version` played on `world` in seeded Choices for `rounds`, with the pictures
 * drawn, so only like runs compare; several runs of a setup pool their plays, and `ALL_STORIES` pools every story's. `score` is the overall, the mean of a play's rubric
 * items, or one item; a play judged without that item is left out.
 */
export function points(results: ChartResult[], version: string, rounds: number, world = "adventure.json", score = OVERALL): Point[] {
  const groups = new Map<
    string,
    { setup: Point["setup"]; label: string; detail: string; runs: number; plays: { score: number; cost: number; turnMs: number; firstMs: number }[] }
  >();
  // A version's runs judged by an older rubric than its newest are left out, as their scores don't compare.
  const rubric = Math.max(0, ...results.filter((result) => String(result.version) === version).map((result) => result.rubric ?? 1));
  for (const result of results) {
    const like =
      String(result.version) === version &&
      (result.rubric ?? 1) === rubric &&
      result.rounds === rounds &&
      !result.continued &&
      (result.mode ?? "choices") === "choices" &&
      (world === ALL_STORIES || (result.world ?? "adventure.json") === world);
    if (!like || !result.drawn || !result.setup || !result.judge) continue;
    const { narrator, reviewer, reviewThinking, consistency } = result.models;
    // A check that was off says nothing, so those runs sit with the ones made after it was removed.
    const checked = consistency && consistency !== "off" ? consistency : undefined;
    const label = result.setup === "narrator" ? short(narrator) : [narrator, reviewer, ...(checked ? [checked] : [])].map(short).join(" · ");
    const detail =
      result.setup === "narrator"
        ? `${result.provider} ${narrator}, Thinking ${result.thinking}`
        : `${result.provider} ${narrator}, Thinking ${result.thinking}; Scribe ${reviewer}, Thinking ${reviewThinking}${checked ? `; consistency ${checked}` : ""}`;
    const key = `${result.setup}|${detail}`;
    const group = groups.get(key) ?? { setup: result.setup, label, detail, runs: 0, plays: [] };
    group.runs++;
    result.plays.forEach((flat, at) => {
      const play = result.judge!.plays[at];
      const judged = play?.scores ?? {};
      const item = judged[score] ?? play?.genres?.[score];
      const scores =
        score === OVERALL ? (play?.overall !== undefined ? [play.overall] : Object.values(judged).map(({ score }) => score)) : item ? [item.score] : [];
      if (!scores.length) return;
      group.plays.push({
        score: mean(scores),
        cost: (flat["cost.total"] ?? 0) / Math.max(1, flat.turns ?? 0),
        turnMs: flat["timing.turn.median"] ?? 0,
        firstMs: flat["timing.firstText.median"] ?? 0,
      });
    });
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter(({ plays }) => plays.length)
    .map(({ setup, label, detail, runs, plays }) => ({
      setup,
      label,
      detail,
      score: mean(plays.map((p) => p.score)),
      low: Math.min(...plays.map((p) => p.score)),
      high: Math.max(...plays.map((p) => p.score)),
      cost: mean(plays.map((p) => p.cost)),
      turnMs: mean(plays.map((p) => p.turnMs)),
      firstMs: mean(plays.map((p) => p.firstMs)),
      runs,
      plays: plays.length,
    }));
}

/** The setups no other beats on both score and cost, cheapest first. */
export function costFrontier(all: Point[]): Point[] {
  const frontier: Point[] = [];
  for (const point of all.toSorted((a, b) => a.cost - b.cost || b.score - a.score))
    if (point.score > (frontier.at(-1)?.score ?? Number.NEGATIVE_INFINITY)) frontier.push(point);
  return frontier;
}

/** Whether no other setup is at least as good on score, cost and Turn time, and better on one. */
export function bestOnAllThree(point: Point, all: Point[]): boolean {
  return !all.some(
    (other) =>
      other !== point &&
      other.score >= point.score &&
      other.cost <= point.cost &&
      other.turnMs <= point.turnMs &&
      (other.score > point.score || other.cost < point.cost || other.turnMs < point.turnMs),
  );
}

// ---- The page ----

const W = 760;
const H = 440;
const M = { top: 20, right: 30, bottom: 50, left: 56 };
// The palette's blue ramp, fast to slow: dark to light on a light page, bright to dim on a dark one.
const LIGHT = ["#104281", "#86b6ef"];
const DARK = ["#cde2fb", "#256abf"];

const html = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const seconds = (ms: number) => `${(ms / 1000).toFixed(0)}s`;
const dollars = (cost: number) => `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}`;

function mix(pair: string[], t: number) {
  const [a, b] = pair.map((hex) => [1, 3, 5].map((at) => Number.parseInt(hex!.slice(at, at + 2), 16)));
  return `#${a!
    .map((v, i) =>
      Math.round(v + (b![i]! - v) * t)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function chart(title: string, found: Point[], speed: [number, number]) {
  // A log scale can't place a cost of 0, as on a local model or a provider whose prices the bench can't look up.
  const all = found.filter((p) => p.cost > 0);
  const free = found.filter((p) => p.cost <= 0);
  const note = free.length ? `<p>No cost recorded, so not drawn: ${free.map((p) => html(p.detail)).join("; ")}.</p>` : "";
  if (!all.length) return `<section><h2>${title}</h2><p class="empty">No judged, kept runs of this setup yet.</p>${note}</section>`;
  const costs = all.map((p) => p.cost);
  const x0 = Math.min(...costs) / 1.6;
  const x1 = Math.max(...costs) * 1.6;
  const y0 = Math.max(0, Math.floor(Math.min(...all.map((p) => p.low)) - 0.5));
  const y1 = Math.min(10, Math.ceil(Math.max(...all.map((p) => p.high)) + 0.5));
  const x = (cost: number) => M.left + ((Math.log10(cost) - Math.log10(x0)) / (Math.log10(x1) - Math.log10(x0))) * (W - M.left - M.right);
  const y = (score: number) => H - M.bottom - ((score - y0) / (y1 - y0)) * (H - M.top - M.bottom);
  const t = (ms: number) => (speed[1] > speed[0] ? (ms - speed[0]) / (speed[1] - speed[0]) : 0);

  const xTicks: number[] = [];
  for (let decade = 10 ** Math.floor(Math.log10(x0)); decade < x1; decade *= 10)
    for (const step of [1, 2, 5]) if (decade * step >= x0 && decade * step <= x1) xTicks.push(decade * step);
  const yTicks = Array.from({ length: y1 - y0 + 1 }, (_, at) => y0 + at);
  const grid = [
    ...xTicks.map(
      (tick) =>
        `<line class="grid" x1="${x(tick)}" x2="${x(tick)}" y1="${M.top}" y2="${H - M.bottom}"/><text class="tick" x="${x(tick)}" y="${H - M.bottom + 18}" text-anchor="middle">$${Number(tick.toPrecision(1))}</text>`,
    ),
    ...yTicks.map(
      (tick) =>
        `<line class="grid" x1="${M.left}" x2="${W - M.right}" y1="${y(tick)}" y2="${y(tick)}"/><text class="tick" x="${M.left - 8}" y="${y(tick) + 4}" text-anchor="end">${tick}</text>`,
    ),
  ];
  const frontier = costFrontier(all);
  const line = frontier.length > 1 ? `<polyline class="frontier" points="${frontier.map((p) => `${x(p.cost)},${y(p.score)}`).join(" ")}"/>` : "";
  const dots = all.map((p) => {
    const cx = x(p.cost);
    const cy = y(p.score);
    const tip = `${p.detail}\nScore ${p.score.toFixed(2)} (plays ${p.low.toFixed(1)} to ${p.high.toFixed(1)})\n${dollars(p.cost)} a Turn\nTurn ${seconds(p.turnMs)}, first text ${seconds(p.firstMs)}\n${p.runs} run(s), ${p.plays} play(s)`;
    const ring = bestOnAllThree(p, all) ? `<circle class="best" cx="${cx}" cy="${cy}" r="11"/>` : "";
    const anchor = cx > W - 200 ? "end" : "start";
    return `<g><title>${html(tip)}</title><line class="range" x1="${cx}" x2="${cx}" y1="${y(p.low)}" y2="${y(p.high)}"/>${ring}<circle class="dot" style="--c:${mix(LIGHT, t(p.turnMs))};--cd:${mix(DARK, t(p.turnMs))}" cx="${cx}" cy="${cy}" r="7"/><circle class="hit" cx="${cx}" cy="${cy}" r="14"/><text class="label" x="${cx + (anchor === "end" ? -16 : 16)}" y="${cy + 4}" text-anchor="${anchor}">${html(p.label)}</text></g>`;
  });
  const rows = all
    .toSorted((a, b) => b.score - a.score)
    .map(
      (p) =>
        `<tr><td>${html(p.detail)}</td><td>${p.score.toFixed(2)}</td><td>${p.low.toFixed(1)} to ${p.high.toFixed(1)}</td><td>${dollars(p.cost)}</td><td>${seconds(p.turnMs)}</td><td>${p.runs}</td><td>${bestOnAllThree(p, all) ? "yes" : ""}</td></tr>`,
    );
  return `<section><h2>${title}</h2>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${html(title)}: judged score against cost per Turn">
${grid.join("\n")}
<text class="axis" x="${(M.left + W - M.right) / 2}" y="${H - 10}" text-anchor="middle">Cost per Turn (log scale)</text>
<text class="axis" transform="translate(16 ${(M.top + H - M.bottom) / 2}) rotate(-90)" text-anchor="middle">Judged score</text>
${line}
${dots.join("\n")}
</svg>
<details><summary>Table</summary><table><thead><tr><th>Setup</th><th>Score</th><th>Plays</th><th>Cost a Turn</th><th>Turn time</th><th>Runs</th><th>Best on all three</th></tr></thead><tbody>${rows.join("")}</tbody></table></details>
${note}</section>`;
}

// Each setup is its own chart, picked with the Setup selector, and says so when it has no runs in a pick.
const SETUPS: [Point["setup"], string][] = [
  ["narrator", "Narrator alone"],
  ["full", "Narrator and Scribe"],
];

/** The key and both setups' charts for one pick, coloured by the Turn times of that pick alone, `shown` the one not hidden. */
function view(all: Point[], shown: Point["setup"]) {
  const times = all.filter((p) => p.cost > 0).map((p) => p.turnMs);
  const speed: [number, number] = times.length ? [Math.min(...times), Math.max(...times)] : [0, 0];
  return `<div class="key">
<span>Turn time ${times.length ? seconds(speed[0]) : ""}<span class="ramp"></span>${times.length ? seconds(speed[1]) : ""}</span>
<span><span class="ring"></span>No setup beats it on score, cost and speed</span>
<span><span class="dash"></span>No setup beats it on score and cost</span>
<span>Bars: lowest to highest play</span>
</div>
${SETUPS.map(
  ([setup, title]) =>
    `<div data-setup="${setup}"${setup === shown ? "" : " hidden"}>${chart(
      title,
      all.filter((p) => p.setup === setup),
      speed,
    )}</div>`,
).join("\n")}`;
}

// Newest first, comparing each dotted part as a number, so 0.5.0.12 comes before 0.5.0.9.
const byVersion = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let at = 0; at < Math.max(x!.length, y!.length); at++) if ((x![at] ?? 0) !== (y![at] ?? 0)) return (y![at] ?? 0) - (x![at] ?? 0);
  return 0;
};

/**
 * Every bench version, score and story among `results` as one page, with a selector for each. `titles` names each story's world
 * file, such as by its genre; `scores` lists every rubric item and genre score the bench asks, so the picker offers them all,
 * those with no runs yet saying so.
 */
export function chartPage(
  results: ChartResult[],
  rounds: number,
  { date = new Date().toISOString().slice(0, 10), titles = {} as Record<string, string>, scores: known = [] as string[] } = {},
) {
  const charted = results.filter(
    (result) => result.judge && result.drawn && result.setup && result.version !== undefined && result.rounds === rounds && !result.continued,
  );
  const versions = [...new Set(charted.map((result) => String(result.version)))].toSorted(byVersion);
  const worlds = [ALL_STORIES, ...new Set(charted.map((result) => result.world ?? "adventure.json"))].toSorted((a, b) =>
    a === ALL_STORIES ? -1 : b === ALL_STORIES ? 1 : a.localeCompare(b),
  );
  const items = [...new Set(charted.flatMap((result) => result.judge!.plays.flatMap((play) => Object.keys(play.scores))))];
  const genres = [...new Set(charted.flatMap((result) => result.judge!.plays.flatMap((play) => Object.keys(play.genres ?? {}))))].toSorted();
  const scores = [...new Set([OVERALL, ...known, ...items, ...genres])];
  const pick = {
    version: versions[0] ?? "",
    score: OVERALL,
    world: ALL_STORIES,
    setup: (charted.some((result) => result.setup === "full") || !charted.length ? "full" : "narrator") as Point["setup"],
  };
  const views = versions.flatMap((version) =>
    worlds.flatMap((world) =>
      scores.map((score) => {
        const shown = version === pick.version && world === pick.world && score === pick.score;
        return `<div class="view" data-version="${html(version)}" data-world="${html(world)}" data-score="${html(score)}"${shown ? "" : " hidden"}>
${view(points(charted, version, rounds, world, score), pick.setup)}
</div>`;
      }),
    ),
  );
  const select = (name: string, label: string, options: string[], chosen: string, text = (option: string) => option) =>
    `<label>${label} <select data-pick="${name}">${options.map((option) => `<option value="${html(option)}"${option === chosen ? " selected" : ""}>${html(text(option))}</option>`).join("")}</select></label>`;
  const gradient = (pair: string[]) => `linear-gradient(to right, ${pair[0]}, ${pair[1]})`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ink &amp; Thread Bench Chart</title>
<style>
:root { color-scheme: light; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --grid: #e4e3df; --ramp: ${gradient(LIGHT)}; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --grid: #34342f; --ramp: ${gradient(DARK)}; } }
:root[data-theme="dark"] { color-scheme: dark; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --grid: #34342f; --ramp: ${gradient(DARK)}; }
body { margin: 0 auto; max-width: 820px; padding: 24px 16px; background: var(--surface); color: var(--ink); font: 14px/1.5 system-ui, sans-serif; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 32px 0 8px; } p { color: var(--ink-2); margin: 0 0 8px; }
svg { width: 100%; height: auto; display: block; }
.grid { stroke: var(--grid); stroke-width: 1; } .tick, .label { fill: var(--ink-2); font-size: 12px; } .axis { fill: var(--ink-2); font-size: 13px; }
.label { fill: var(--ink); }
.frontier { fill: none; stroke: var(--ink-2); stroke-width: 2; stroke-dasharray: 5 4; }
.range { stroke: var(--ink-2); stroke-width: 2; stroke-linecap: round; opacity: .5; }
.dot { fill: var(--c); stroke: var(--surface); stroke-width: 2; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .dot { fill: var(--cd); } }
:root[data-theme="dark"] .dot { fill: var(--cd); }
.best { fill: none; stroke: var(--ink); stroke-width: 2; } .hit { fill: transparent; }
.picks { display: flex; flex-wrap: wrap; gap: 8px 20px; margin: 16px 0 4px; color: var(--ink-2); font-size: 13px; }
select { font: inherit; color: var(--ink); background: var(--surface); border: 1px solid var(--grid); border-radius: 6px; padding: 4px 6px; }
.key { display: flex; flex-wrap: wrap; gap: 8px 24px; align-items: center; color: var(--ink-2); font-size: 13px; margin: 12px 0; }
.ramp { display: inline-block; width: 120px; height: 10px; border-radius: 5px; background: var(--ramp); vertical-align: middle; margin: 0 6px; }
.ring { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--ink); border-radius: 50%; vertical-align: middle; margin-right: 6px; box-sizing: border-box; }
.dash { display: inline-block; width: 24px; border-top: 2px dashed var(--ink-2); vertical-align: middle; margin-right: 6px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; margin-top: 8px; } th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--grid); }
summary { cursor: pointer; color: var(--ink-2); } .empty { font-style: italic; }
</style></head><body>
<h1>Ink &amp; Thread bench</h1>
<p>Kept and judged runs of ${rounds} rounds with pictures drawn, charted ${date}. Higher is better, further left is cheaper. Hover a dot for its numbers.</p>
<div class="picks">
${select("version", "Bench version", versions, pick.version)}
${select("score", "Score", scores, pick.score, (score) => (score === OVERALL ? "Overall" : score[0]!.toUpperCase() + score.slice(1)))}
${select("world", "Story", worlds, pick.world, (world) => (world === ALL_STORIES ? "All stories" : (titles[world] ?? world.replace(/\.json$/, ""))))}
${select(
  "setup",
  "Setup",
  SETUPS.map(([setup]) => setup),
  pick.setup,
  (setup) => (setup === "narrator" ? "Narrator only" : "With a Scribe"),
)}
</div>
${views.length ? views.join("\n") : view([], pick.setup)}
<script>
const picks = [...document.querySelectorAll("[data-pick]")];
const show = () => {
  const chosen = Object.fromEntries(picks.map((select) => [select.dataset.pick, select.value]));
  for (const view of document.querySelectorAll(".view")) view.hidden = ["version", "world", "score"].some((name) => view.dataset[name] !== chosen[name]);
  for (const chart of document.querySelectorAll("[data-setup]")) chart.hidden = chart.dataset.setup !== chosen.setup;
};
for (const select of picks) select.addEventListener("change", show);
</script>
</body></html>
`;
}
