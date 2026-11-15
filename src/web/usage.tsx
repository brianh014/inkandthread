import { Fragment, useEffect, useState } from "react";
import type { UsagePeriod } from "../usage-store";
import { getNarratorUsage, getUsage, type NarratorStory, type Usage } from "./api";
import { Choices } from "./art-style-picker";

const PERIODS: Record<string, UsagePeriod> = { Day: "day", Week: "week", Month: "month" };
const METRICS = { Requests: "requests", Tokens: "tokens", Cost: "cost" } as const;
type Metric = (typeof METRICS)[keyof typeof METRICS];
/** How many periods the charts show, ending with the current one. */
const SPAN: Record<UsagePeriod, number> = { day: 14, week: 12, month: 12 };
/** The categorical colours, in a fixed order; the fifth model on and beyond folds into Other. */
const SLOTS = 4;

type Row = Usage["text"][number] | Usage["images"][number];
type Tally = { requests: number; failed: number; tokensIn: number; tokensOut: number; cached: number; cost: number | null; priced: number };

const count = (n: number) => n.toLocaleString();
const compact = (n: number) => n.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 });
const money = (cost: number) => (cost === 0 ? "$0" : cost < 0.00005 ? "< $0.0001" : `$${cost.toFixed(cost < 0.01 ? 4 : 2)}`);
/** A dash where no request reported a cost, and "at least" where only some did. */
const dollars = ({ cost, priced, requests }: Pick<Tally, "cost" | "priced" | "requests">) =>
  cost === null ? "—" : priced < requests ? `≥ ${money(cost)}` : money(cost);

const pad = (n: number) => String(n).padStart(2, "0");
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dateOf = (period: string) => {
  const [y, m, d = 1] = period.split("-").map(Number);
  return new Date(y!, m! - 1, d);
};

/** The last `SPAN` periods up to `today`, oldest first, keyed as the server keys them: a day, its week's Monday, or `YYYY-MM`. */
export function recentPeriods(by: UsagePeriod, today = new Date()) {
  return Array.from({ length: SPAN[by] }, (_, back) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const i = SPAN[by] - 1 - back;
    if (by === "day") d.setDate(d.getDate() - i);
    if (by === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - 7 * i);
    if (by === "month") d.setMonth(d.getMonth() - i, 1);
    return by === "month" ? isoDay(d).slice(0, 7) : isoDay(d);
  });
}

const shortName = (period: string, by: UsagePeriod) => {
  const d = dateOf(period);
  if (by === "day") return String(d.getDate());
  return d.toLocaleDateString(undefined, by === "week" ? { day: "numeric", month: "short" } : { month: "short" });
};
const longName = (period: string, by: UsagePeriod) => {
  const d = dateOf(period);
  if (by === "day") return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  if (by === "week") return `Week of ${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
};

function tally(rows: Row[]): Tally {
  const sum: Tally = { requests: 0, failed: 0, tokensIn: 0, tokensOut: 0, cached: 0, cost: null, priced: 0 };
  for (const row of rows) {
    sum.requests += row.requests;
    sum.failed += row.failed;
    sum.priced += row.priced;
    if (row.cost !== null) sum.cost = (sum.cost ?? 0) + row.cost;
    if ("tokensIn" in row) {
      sum.tokensIn += row.tokensIn;
      sum.tokensOut += row.tokensOut;
      sum.cached += row.cached;
    }
  }
  return sum;
}

const measure = (sum: Tally, metric: Metric) => (metric === "requests" ? sum.requests : metric === "tokens" ? sum.tokensIn + sum.tokensOut : (sum.cost ?? 0));
const shown = (sum: Tally, metric: Metric) =>
  metric === "requests" ? count(sum.requests) : metric === "tokens" ? compact(sum.tokensIn + sum.tokensOut) : dollars(sum);
const tick = (value: number, metric: Metric) => (metric === "cost" ? money(value) : compact(value));

/** The smallest of 1, 2, 2.5 and 5 times a power of ten that holds `most`. */
export function niceCeiling(most: number) {
  const power = 10 ** Math.floor(Math.log10(most));
  return [1, 2, 2.5, 5, 10].map((f) => f * power).find((top) => top >= most * 0.9999)!;
}

type Series = { id: string; name: string; provider: string; slot: number | "other"; keys: Set<string> };
const keyOf = (row: Row) => `${row.provider} ${row.model}`;

/** How many colours a chart of these rows takes: one per model, or all but one and Other. */
const coloursFor = (rows: Row[]) => {
  const models = new Set(rows.map(keyOf)).size;
  return models > SLOTS ? SLOTS - 1 : models;
};

/**
 * One column per period, each a stack of the models' tallies. Models rank by requests in the span, so the Show switch
 * never repaints them; the first `SLOTS` keep their colours and the rest fold into Other. `slots` is the order the colours
 * are given in, so pictures' models can take the ones the text models left.
 */
export function stacks(rows: Row[], periods: string[], slots = [0, 1, 2, 3]) {
  const ranked = new Map<string, { row: Row; requests: number }>();
  for (const row of rows) {
    const seen = ranked.get(keyOf(row));
    ranked.set(keyOf(row), { row, requests: (seen?.requests ?? 0) + row.requests });
  }
  const order = [...ranked.values()].sort((a, b) => b.requests - a.requests);
  const series: Series[] = order
    .slice(0, order.length > SLOTS ? SLOTS - 1 : SLOTS)
    .map(({ row }, i) => ({ id: keyOf(row), name: row.model || "—", provider: row.provider, slot: slots[i]!, keys: new Set([keyOf(row)]) }));
  if (order.length > SLOTS)
    series.push({
      id: "other",
      name: "Other",
      provider: `${order.length - SLOTS + 1} models`,
      slot: "other",
      keys: new Set(order.slice(SLOTS - 1).map(({ row }) => keyOf(row))),
    });
  const columns = periods.map((period) => {
    const here = rows.filter((row) => row.period === period);
    return { period, parts: series.map((s) => ({ series: s, sum: tally(here.filter((row) => s.keys.has(keyOf(row)))) })) };
  });
  const totals = series.map((s) => tally(rows.filter((row) => s.keys.has(keyOf(row)))));
  return { series, columns, totals };
}

function UsageChart(props: { title: string; rows: Row[]; periods: string[]; by: UsagePeriod; metric: Metric; slots?: number[] }) {
  const [hovered, setHovered] = useState<number>();
  if (props.rows.length === 0) return null;
  const { series, columns, totals } = stacks(props.rows, props.periods, props.slots);
  const most = Math.max(...columns.map(({ parts }) => parts.reduce((sum, part) => sum + measure(part.sum, props.metric), 0)));
  const top = most > 0 ? niceCeiling(most) : 0;
  const tip = hovered === undefined ? undefined : columns[hovered];
  return (
    <section className="usage-chart">
      <h3>{props.title}</h3>
      {top === 0 ? (
        <p className="muted">{props.metric === "cost" ? "No cost was reported in this time." : "Nothing in this time."}</p>
      ) : (
        <div className="usage-plot">
          <div className="usage-axis" aria-hidden="true">
            <span>{tick(top, props.metric)}</span>
            <span>{tick(top / 2, props.metric)}</span>
            <span>{tick(0, props.metric)}</span>
          </div>
          <div className="usage-columns" role="img" aria-label={`${props.title} ${props.metric} by ${props.by}. Show as a table for the numbers.`}>
            {columns.map(({ period, parts }, index) => (
              // biome-ignore lint/a11y/noStaticElementInteractions: hovering only adds a tooltip, and Show as a table holds the same numbers.
              <div
                key={period}
                className="usage-column"
                data-hovered={index === hovered || undefined}
                onMouseEnter={() => setHovered(index)}
                onMouseLeave={() => setHovered(undefined)}
              >
                {parts.map(({ series: s, sum }) => {
                  const value = measure(sum, props.metric);
                  return value > 0 && <span key={s.id} className="usage-segment" data-slot={s.slot} style={{ height: `${(value / top) * 100}%` }} />;
                })}
              </div>
            ))}
            {tip && hovered !== undefined && (
              <div
                className="usage-tip"
                data-side={hovered < columns.length / 2 ? "left" : "right"}
                style={{ "--at": `${((hovered + 0.5) / columns.length) * 100}%` } as React.CSSProperties}
              >
                <strong>
                  {longName(tip.period, props.by)} · {shown(tally(props.rows.filter((row) => row.period === tip.period)), props.metric)}
                </strong>
                {tip.parts
                  .filter(({ sum }) => sum.requests > 0)
                  .map(({ series: s, sum }) => (
                    <span key={s.id}>
                      <i className="usage-swatch" data-slot={s.slot} />
                      {s.name} · {count(sum.requests)} requests{sum.tokensIn + sum.tokensOut > 0 && ` · ${compact(sum.tokensIn + sum.tokensOut)} tokens`} ·{" "}
                      {dollars(sum)}
                    </span>
                  ))}
              </div>
            )}
          </div>
          <span />
          <div className="usage-labels" aria-hidden="true">
            {columns.map(({ period }) => (
              <span key={period}>{shortName(period, props.by)}</span>
            ))}
          </div>
        </div>
      )}
      <ul className="usage-legend">
        {series.map((s, i) => (
          <li key={s.id}>
            <i className="usage-swatch" data-slot={s.slot} />
            {s.name} <span className="muted">{s.provider}</span> <b>{shown(totals[i]!, props.metric)}</b>
          </li>
        ))}
      </ul>
    </section>
  );
}

function UsageTable<R extends Row>(props: { caption: string; rows: R[]; by: UsagePeriod; columns: [string, (row: R) => string][] }) {
  if (props.rows.length === 0) return null;
  const periods = [...new Set(props.rows.map(({ period }) => period))];
  const heads = ["Provider", "Model", "Requests", "Failed", ...props.columns.map(([name]) => name), "Cost"];
  return (
    <div className="usage-table">
      <table>
        <caption>{props.caption}</caption>
        <thead>
          <tr>
            {heads.map((name) => (
              <th key={name} scope="col">
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {periods.map((period) => (
            <Fragment key={period}>
              <tr>
                <th scope="colgroup" colSpan={heads.length} className="period">
                  {longName(period, props.by)}
                </th>
              </tr>
              {props.rows
                .filter((row) => row.period === period)
                .map((row) => (
                  <tr key={keyOf(row)}>
                    <td>{row.provider}</td>
                    <td>{row.model || "—"}</td>
                    <td>{count(row.requests)}</td>
                    <td>{count(row.failed)}</td>
                    {props.columns.map(([name, cell]) => (
                      <td key={name}>{cell(row)}</td>
                    ))}
                    <td title={row.priced < row.requests && row.cost !== null ? `${row.priced} of ${row.requests} requests reported a cost` : undefined}>
                      {dollars(row)}
                    </td>
                  </tr>
                ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** How many player's Turns in a row without something before the Narrator table points it out. */
export const QUIET_TURNS = 50;

/** What a story's Turns would show if the Narrator kept skipping its tools, worded for the Narrator table. */
export function quietNotes({ title, model, sinceCheck, sinceTime, latest }: Pick<NarratorStory, "title" | "model" | "sinceCheck" | "sinceTime" | "latest">) {
  // A model the story has moved on from isn't skipping anything now.
  if (!latest) return [];
  const who = `${title}, ${model || "—"}`;
  return [
    sinceCheck >= QUIET_TURNS && `${who}: no Check in the last ${count(sinceCheck)} Turns.`,
    sinceTime >= QUIET_TURNS && `${who}: story time hasn't moved in ${count(sinceTime)} Turns.`,
  ].filter((note): note is string => !!note);
}

const NARRATOR_COLUMNS: [string, (row: NarratorStory) => string][] = [
  ["Turns", (row) => count(row.turns)],
  ["Checks", (row) => count(row.checks)],
  ["Easy / Moderate / Hard / Very Hard", (row) => [row.easy, row.moderate, row.hard, row.veryHard].map(count).join(" / ")],
  ["No change", (row) => count(row.unchanged)],
  ["Time moved", (row) => count(row.timeMoved)],
  ["Scenes", (row) => count(row.scenes)],
  ["Facts", (row) => count(row.facts)],
  ["Loose Ends opened / settled", (row) => `${count(row.looseOpened)} / ${count(row.looseClosed)}`],
  ["Plot Threads new / moved / ended", (row) => `${count(row.threadsAdded)} / ${count(row.threadsMoved)} / ${count(row.threadsResolved)}`],
];

/** How the Narrator used its tools in each story: Checks and state changes over the player's Turns, for each model that wrote there. */
function NarratorTable() {
  const [stories, setStories] = useState<NarratorStory[]>();
  const [error, setError] = useState("");
  useEffect(() => {
    getNarratorUsage().then(
      ({ stories }) => setStories(stories),
      (failure: Error) => setError(failure.message),
    );
  }, []);
  if (error)
    return (
      <p role="alert" className="error">
        {error}
      </p>
    );
  if (!stories) return null;
  const notes = stories.flatMap(quietNotes);
  return (
    <section className="usage-narrator">
      <h3>Narrator</h3>
      <p className="muted">
        What the Narrator did in each story over your Turns, from when this count began, for each model that wrote there. Few Checks, or many Turns with no
        change, mean the AI is skipping its tools. Turns you later Reverted, Rewrote or Regenerated stay counted as first played. Counts only, nothing of your
        story.
      </p>
      {stories.length === 0 ? (
        <p className="muted">No Turns counted yet.</p>
      ) : (
        <div className="usage-table">
          <table>
            <caption className="visually-hidden">The Narrator's Checks and state changes, by story and model</caption>
            <thead>
              <tr>
                {["Story", "Model", ...NARRATOR_COLUMNS.map(([name]) => name)].map((name) => (
                  <th key={name} scope="col">
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stories.map((row) => (
                <tr key={`${row.save} ${row.model}`}>
                  <td>{row.title}</td>
                  <td>{row.model || "—"}</td>
                  {NARRATOR_COLUMNS.map(([name, cell]) => (
                    <td key={name}>{cell(row)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {notes.length > 0 && (
        <ul className="usage-notes">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Usage: how many AI requests went to each provider and model, with tokens and the cost where the provider reports it. */
export function UsageSection() {
  const [by, setBy] = useState<UsagePeriod>("day");
  const [metric, setMetric] = useState<Metric>("cost");
  const [asTable, setAsTable] = useState(false);
  // Kept with the period it was asked by, so the old period's rows never show under the new one's dates.
  const [loaded, setLoaded] = useState<{ by: UsagePeriod; usage: Usage }>();
  const [error, setError] = useState("");

  useEffect(() => {
    setError("");
    // A reply for a period the player has since left is dropped, should it come in last.
    let current = true;
    getUsage(by).then(
      (usage) => current && setLoaded({ by, usage }),
      (failure: Error) => current && setError(failure.message),
    );
    return () => {
      current = false;
    };
  }, [by]);
  const usage = loaded?.by === by ? loaded.usage : undefined;

  const periods = recentPeriods(by);
  const inSpan = <R extends Row>(rows: R[]) => rows.filter((row) => periods.includes(row.period));
  const text = usage ? inSpan(usage.text) : [];
  const images = usage ? inSpan(usage.images) : [];
  const all = tally([...text, ...images]);
  // The colours the text models leave come first, so the two charts share one only past four models in all.
  const taken = coloursFor(text);
  const imageSlots = [0, 1, 2, 3].slice(taken).concat([0, 1, 2, 3].slice(0, taken));
  const words = tally(text);
  const nameOf = <T extends string>(names: Record<string, T>, value: T) => Object.keys(names).find((name) => names[name] === value)!;
  return (
    <div className="fields usage">
      <h2>Usage</h2>
      <p className="muted">
        Every request to the AI, by provider and model. Cost is what the provider reported: a dash where it reports none, and ≥ where only some requests did.
      </p>
      <div className="usage-controls">
        <Choices
          legend="Show"
          options={Object.keys(METRICS)}
          value={nameOf(METRICS, metric)}
          onChange={(name) => setMetric(METRICS[name as keyof typeof METRICS])}
        />
        <Choices legend="By" options={Object.keys(PERIODS)} value={nameOf(PERIODS, by)} onChange={(name) => setBy(PERIODS[name]!)} />
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {usage &&
        (text.length + images.length === 0 ? (
          <p className="muted">No requests in this time.</p>
        ) : (
          <>
            <dl className="usage-totals">
              <div>
                <dt>Cost reported</dt>
                <dd>{dollars(all)}</dd>
              </div>
              <div>
                <dt>Requests</dt>
                <dd>{count(all.requests)}</dd>
              </div>
              <div>
                <dt>Tokens in / out</dt>
                <dd>
                  {compact(words.tokensIn)} / {compact(words.tokensOut)}
                </dd>
              </div>
              <div>
                <dt>Cached</dt>
                <dd>{words.tokensIn > 0 ? `${Math.round((words.cached / words.tokensIn) * 100)}%` : "—"}</dd>
              </div>
            </dl>
            {asTable ? (
              <>
                <UsageTable
                  caption="Text"
                  rows={text}
                  by={by}
                  columns={[
                    ["Tokens in", (row) => count(row.tokensIn)],
                    ["Tokens out", (row) => count(row.tokensOut)],
                    ["Cached", (row) => count(row.cached)],
                  ]}
                />
                <UsageTable caption="Images" rows={images} by={by} columns={[]} />
              </>
            ) : (
              <>
                <UsageChart title="Text" rows={text} periods={periods} by={by} metric={metric} />
                {metric === "tokens" ? (
                  images.length > 0 && <p className="muted">Pictures have no tokens, so they show under Requests and Cost.</p>
                ) : (
                  <UsageChart title="Images" rows={images} periods={periods} by={by} metric={metric} slots={imageSlots} />
                )}
              </>
            )}
            <div>
              <button type="button" className="quiet" onClick={() => setAsTable(!asTable)}>
                {asTable ? "Show as a chart" : "Show as a table"}
              </button>
            </div>
          </>
        ))}
      <NarratorTable />
    </div>
  );
}
