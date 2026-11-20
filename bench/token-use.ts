/** One text call as the bench counts it: its role (`side.call`), its usage, and the bench step it began in. */
export type Call = { role: string; ms: number; in: number; cached: number; out: number; reasoning: number; cost: number; step: number };

const PARTS = ["in", "cached", "out", "reasoning", "cost"] as const;

const median = (values: number[]) => (values.length ? values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]! : 0);

/**
 * Each kind of call's count, totals and the median a Turn spends on it, and `tokens.perTurn.*` over all calls, so token use
 * can be compared across versions. `turns` are the steps that played a Turn, each counted even when a kind spent nothing in it.
 * shortcut: a call counts in the step it began in, so World Moves On, which runs on after its Turn, can land in the next one.
 */
export function tokenUse(calls: Call[], turns: number[]) {
  const flat: Record<string, number> = {};
  const perTurn = (mine: Call[], part: (typeof PARTS)[number]) =>
    median(turns.map((step) => mine.filter((call) => call.step === step).reduce((sum, call) => sum + call[part], 0)));
  for (const role of new Set(calls.map(({ role }) => role))) {
    const mine = calls.filter((call) => call.role === role);
    flat[`calls.${role}`] = mine.length;
    for (const part of PARTS) {
      flat[part === "cost" ? `cost.${role}` : `tokens.${role}.${part}`] = mine.reduce((sum, call) => sum + call[part], 0);
      flat[`tokens.${role}.perTurn.${part}`] = perTurn(mine, part);
    }
  }
  for (const part of PARTS) flat[`tokens.perTurn.${part}`] = perTurn(calls, part);
  return flat;
}

/** The run summary's table of token use by kind of call, one row each, most tokens in first. */
export function tokenTable(summary: Record<string, number>) {
  const roles = Object.keys(summary)
    .filter((key) => key.startsWith("calls."))
    .map((key) => key.slice("calls.".length))
    .toSorted((a, b) => (summary[`tokens.${b}.in`] ?? 0) - (summary[`tokens.${a}.in`] ?? 0));
  const n = (value = 0) => String(Math.round(value)).padStart(10);
  const money = (value = 0) => value.toFixed(4).padStart(10);
  const row = (name: string, key: (part: string) => string, calls: string) =>
    `  ${name.padEnd(28)}${calls}${["in", "cached", "out", "reasoning"].map((part) => n(summary[key(part)])).join("")}`;
  return [
    `  ${"Tokens by call".padEnd(28)}${"calls".padStart(7)}${["in", "cached", "out", "reasoning", "cost", "in/Turn", "out/Turn", "$/Turn"].map((head) => head.padStart(10)).join("")}`,
    ...roles.map(
      (role) =>
        `${row(role, (part) => `tokens.${role}.${part}`, String(Math.round(summary[`calls.${role}`] ?? 0)).padStart(7))}${money(summary[`cost.${role}`])}${n(summary[`tokens.${role}.perTurn.in`])}${n(summary[`tokens.${role}.perTurn.out`])}${money(summary[`tokens.${role}.perTurn.cost`])}`,
    ),
    `${row("per Turn (median, all calls)", (part) => `tokens.perTurn.${part}`, "".padStart(7))}${money(summary["tokens.perTurn.cost"])}`,
  ].join("\n");
}
