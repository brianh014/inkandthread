// Runs a test story's cases through what play does after a reply: the consistency questions and their fixes, then State
// Upkeep on the fixed reply. The story is invented (scripts/consistency-cases/*.json), so it holds no player's text.
// It sends each case to the real Consistency model and reviewer from Settings, which costs real money:
//   bun run scripts/consistency-cases.ts [cases.json] [settings.json] [--only id-prefix]
import { checkConsistency, type Name, type ReplyToCheck } from "../src/consistency";
import { consistencySettings, reviewerSettings, settingsStore } from "../src/settings-store";
import { openingState, type StoryTime } from "../src/state-applier";
import { upkeepOperations } from "../src/state-upkeep";
import { textProvider } from "../src/text-provider";
import { type TextProvider, usableFix } from "../src/turn-engine";

const args = process.argv.slice(2);
const option = (flag: string) => {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args.splice(at, 2)[1];
};
const only = option("--only");
const [casesPath = "scripts/consistency-cases/salt-road.json", settingsPath = "settings.json"] = args;

type Base = Omit<ReplyToCheck, "visualDescription" | "narration" | "timeAfter"> & {
  carrying: string[];
  location: string;
  timeBefore: StoryTime;
  reply: string;
};
type Case = Partial<Base> & {
  id: string;
  timeAfter?: StoryTime;
  visualDescription?: string;
  slips: Name[];
  gone?: string[];
  kept?: string[];
  upkeep?: { has?: string[]; not?: string[] };
};
const { base, cases } = JSON.parse(await Bun.file(casesPath).text()) as { base: Base; cases: Case[] };

const settings = settingsStore(settingsPath);
let checkCost = 0;
let reviewCost = 0;
const costed =
  (provider: TextProvider, add: (cost: number) => void): TextProvider =>
  (prompt, request) =>
    provider(prompt, { ...request, onUsage: (usage) => add(usage.cost ?? 0) });
const checker = consistencySettings(settings);
const consistency = {
  provider: costed(textProvider(checker), (cost) => (checkCost += cost)),
  settings: checker,
  enabled: () => true,
  logOnly: false,
};
const counted = costed(textProvider(reviewerSettings(settings)), (cost) => (reviewCost += cost));
const signal = new AbortController().signal;
const keyOf = (operation: Record<string, unknown>) => [operation.op, operation.slot ?? operation.name].filter(Boolean).join(":");

let slipsFixed = 0;
let slipCases = 0;
let fineKept = 0;
let fineCases = 0;
let upkeepMet = 0;
let upkeepAsked = 0;
// How long the questions hold back the choices and picture, per case.
const waits: number[] = [];
for (const entry of cases.filter(({ id }) => !only || id.startsWith(only))) {
  const at = { ...base, ...entry };
  const narration = (entry.reply ?? base.reply).replace("{reply}", base.reply);
  const visualDescription = entry.visualDescription ?? "";
  const reply: ReplyToCheck = { ...at, timeAfter: entry.timeAfter ?? at.timeBefore, narration, visualDescription };
  const result = await checkConsistency(consistency, reply, (text) => usableFix(text, at.pc, narration), signal);
  waits.push(result.checked.ms);
  const text = `${result.narration}\n${result.visualDescription}`;
  const left = (entry.gone ?? []).filter((words) => text.includes(words));
  const lost = (entry.kept ?? []).filter((words) => !text.includes(words));
  let verdict: string;
  if (entry.slips.length > 0) {
    slipCases++;
    const fixed = result.narration !== narration && left.length === 0 && lost.length === 0;
    if (fixed) slipsFixed++;
    verdict = fixed ? "FIXED" : result.narration === narration ? "MISSED" : `BAD FIX (left ${JSON.stringify(left)}, lost ${JSON.stringify(lost)})`;
  } else {
    fineCases++;
    const same = result.narration === narration && result.visualDescription === visualDescription;
    if (same) fineKept++;
    verdict = same ? "unchanged" : "CHANGED A FINE REPLY";
  }
  const state = {
    ...structuredClone(openingState),
    inventory: { wearing: at.wearing, carrying: at.carrying },
    npcs: at.cast,
    scene: { location: at.location, visibleCast: at.cast.map(({ name }) => name) },
    pcKnown: { facts: at.facts, npcs: at.cast.map(({ name }) => name) },
    summary: at.summary,
    storyTime: reply.timeAfter,
  };
  const operations = (
    (await upkeepOperations({ provider: counted, settings, input: at.input }, at.pc, state, undefined, at.previous, result.narration, signal)) ?? []
  ).map((operation) => keyOf(operation));
  const missing = (entry.upkeep?.has ?? []).filter((key) => !operations.some((given) => given.startsWith(key)));
  const unwanted = (entry.upkeep?.not ?? []).filter((key) => operations.some((given) => given.startsWith(key)));
  if (entry.upkeep) {
    upkeepAsked++;
    if (missing.length === 0 && unwanted.length === 0) upkeepMet++;
  }
  const upkeepVerdict = entry.upkeep ? (missing.length || unwanted.length ? ` UPKEEP WRONG (missing ${missing}, unwanted ${unwanted})` : " upkeep ok") : "";
  const { claimed, verified, edits, outcome } = result.checked;
  const shown = `claimed ${claimed}, verified ${verified}, edits ${edits}`;
  console.log(`${entry.id.padEnd(32)} ${shown.padEnd(36)} ${outcome.padEnd(10)} ${verdict}${upkeepVerdict} [${operations.join(", ")}]`);
  if (result.narration !== narration) {
    const before = narration.split("\n");
    const after = result.narration.split("\n");
    for (let line = 0; line < Math.max(before.length, after.length); line++) {
      if (before[line] !== after[line]) console.log(`    - ${before[line] ?? ""}\n    + ${after[line] ?? ""}`);
    }
  }
}

console.log(`\n${checker.read().textModel}`);
console.log(`Slips fixed ${slipsFixed}/${slipCases}, fine replies unchanged ${fineKept}/${fineCases}, State Upkeep right ${upkeepMet}/${upkeepAsked}`);
const sorted = waits.toSorted((a, b) => a - b);
const seconds = (ms = 0) => (ms / 1000).toFixed(1);
console.log(
  `Questions: median ${seconds(sorted[Math.floor(sorted.length / 2)])} s, mean ${seconds(waits.reduce((a, b) => a + b, 0) / waits.length)} s, slowest ${seconds(sorted.at(-1))} s`,
);
console.log(`Cost: check $${checkCost.toFixed(4)}, reviewer $${reviewCost.toFixed(4)}`);
