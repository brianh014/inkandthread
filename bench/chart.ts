// `bun bench chart`: the kept runs of one bench version as two charts, judged score against cost per Turn, coloured by Turn time,
// one for the Narrator alone and one for the Narrator with a reviewer and decision model. A self-contained page, no scripts.

/** The parts of a bench result the chart reads (bench.ts's `Result`). */
export type ChartResult = {
  version?: number;
  setup?: "narrator" | "full";
  rounds: number;
  mode?: string;
  world?: string;
  drawn?: boolean;
  provider: string;
  thinking: string;
  models: { narrator: string; reviewer: string; reviewThinking: string; consistency: string };
  judge: { plays: { scores: Record<string, { score: number }> }[] } | null;
  plays: Record<string, number>[];
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

/**
 * One point per setup, from every judged result of `version` played on `world` in seeded Choices for `rounds`, with the pictures
 * drawn, so only like runs compare; several runs of a setup pool their plays.
 */
export function points(results: ChartResult[], version: number, rounds: number, world = "world.json"): Point[] {
  const groups = new Map<
    string,
    { setup: Point["setup"]; label: string; detail: string; runs: number; plays: { score: number; cost: number; turnMs: number; firstMs: number }[] }
  >();
  for (const result of results) {
    const like = result.version === version && result.rounds === rounds && (result.mode ?? "choices") === "choices" && (result.world ?? "world.json") === world;
    if (!like || !result.drawn || !result.setup || !result.judge) continue;
    const { narrator, reviewer, reviewThinking, consistency } = result.models;
    const label = result.setup === "narrator" ? short(narrator) : [narrator, reviewer, consistency].map(short).join(" · ");
    const detail =
      result.setup === "narrator"
        ? `${result.provider} ${narrator}, Thinking ${result.thinking}`
        : `${result.provider} ${narrator}, Thinking ${result.thinking}; reviewer ${reviewer}, Thinking ${reviewThinking}; decisions ${consistency}`;
    const key = `${result.setup}|${detail}`;
    const group = groups.get(key) ?? { setup: result.setup, label, detail, runs: 0, plays: [] };
    group.runs++;
    result.plays.forEach((flat, at) => {
      const scores = Object.values(result.judge!.plays[at]?.scores ?? {}).map(({ score }) => score);
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

export function chartPage(all: Point[], version: number, rounds: number, world = "world.json", date = new Date().toISOString().slice(0, 10)) {
  const times = all.filter((p) => p.cost > 0).map((p) => p.turnMs);
  const speed: [number, number] = times.length ? [Math.min(...times), Math.max(...times)] : [0, 0];
  const gradient = (pair: string[]) => `linear-gradient(to right, ${pair[0]}, ${pair[1]})`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>NovelForge Bench Chart</title>
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
.key { display: flex; flex-wrap: wrap; gap: 8px 24px; align-items: center; color: var(--ink-2); font-size: 13px; margin: 12px 0; }
.ramp { display: inline-block; width: 120px; height: 10px; border-radius: 5px; background: var(--ramp); vertical-align: middle; margin: 0 6px; }
.ring { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--ink); border-radius: 50%; vertical-align: middle; margin-right: 6px; box-sizing: border-box; }
.dash { display: inline-block; width: 24px; border-top: 2px dashed var(--ink-2); vertical-align: middle; margin-right: 6px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; margin-top: 8px; } th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--grid); }
summary { cursor: pointer; color: var(--ink-2); } .empty { font-style: italic; }
</style></head><body>
<h1>NovelForge bench</h1>
<p>Bench version ${version}, kept and judged runs of ${rounds} rounds on ${html(world)} with pictures drawn, charted ${date}. Higher is better, further left is cheaper. Hover a dot for its numbers.</p>
<div class="key">
<span>Turn time ${times.length ? seconds(speed[0]) : ""}<span class="ramp"></span>${times.length ? seconds(speed[1]) : ""}</span>
<span><span class="ring"></span>No setup beats it on score, cost and speed</span>
<span><span class="dash"></span>No setup beats it on score and cost</span>
<span>Bars: lowest to highest play</span>
</div>
${chart(
  "Narrator alone",
  all.filter((p) => p.setup === "narrator"),
  speed,
)}
${chart(
  "Narrator, reviewer and decision model",
  all.filter((p) => p.setup === "full"),
  speed,
)}
</body></html>
`;
}
