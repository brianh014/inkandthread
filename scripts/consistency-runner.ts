// Measures the consistency questions on a marked set, so each change to a question, its slice or its cut-off is judged on the
// same replies. Run it yourself, from the project folder, so the API key stays with you, and only with the player's go-ahead,
// as it sends story text to a real decision model and costs real money:
//   bun run scripts/consistency-runner.ts <Saves folder> <marked set.json> [settings.json] [--runs 2]
// The Saves folder must be a scratch copy, never the player's own. The marked set is JSON, kept in the scratchpad as it names
// replies by id: [{ "save": "<Save id>", "reply": <Narrator Message id>, "slips": ["time"] }], with slips empty for a fine reply.
// The Consistency model and its key come from Settings, as the app uses them. Each question is asked as play asks it, with the
// slice play sends. --runs asks each reply more than once, to see how stable the answers are.
import { CUT_OFFS, type Name, QUESTIONS, slices } from "../src/consistency";
import { decisionProvider } from "../src/decisions";
import { saveStore } from "../src/save-store";
import { settingsStore } from "../src/settings-store";

const args = process.argv.slice(2);
const at = args.indexOf("--runs");
const runs = at === -1 ? 1 : Number(args.splice(at, 2)[1]);
const [savesDir, markedPath, settingsPath = "settings.json"] = args;
if (!savesDir || !markedPath || !(runs >= 1)) throw new Error("Give a Saves folder and a marked set, and --runs a number from 1");

type Marked = { save: string; reply: number; slips: Name[] };
const marked = JSON.parse(await Bun.file(markedPath).text()) as Marked[];
const saves = saveStore(savesDir);
const settings = settingsStore(settingsPath);
let cost = 0;
const decide = decisionProvider(settings, (usage) => (cost += usage.cost ?? 0));
const NAMES = Object.keys(QUESTIONS) as Name[];

/** The reply and what it follows from, as narrate builds them: the Snapshot before its player Message, and its own. */
function replyToCheck({ save, reply }: Marked) {
  const messages = saves.messages(save);
  const at = messages.findIndex(({ id }) => id === reply);
  const input = messages[at - 1]!;
  const before = saves.snapshot(save, messages[at - 2]?.id ?? input.id);
  const after = saves.snapshot(save, reply);
  return {
    previous: messages.slice(0, at - 1).findLast(({ role }) => role === "narrator")?.text ?? "",
    input: input.text,
    timeBefore: before.storyTime,
    timeAfter: after.storyTime,
    narration: messages[at]!.text,
    visualDescription: "",
  };
}

type Tally = { caught: number; missed: number; falseAlarms: number; unanswered: number; scores: number[][] };
const tallies = Object.fromEntries(NAMES.map((name): [Name, Tally] => [name, { caught: 0, missed: 0, falseAlarms: 0, unanswered: 0, scores: [] }])) as Record<
  Name,
  Tally
>;
const started = Date.now();
const signal = new AbortController().signal;
for (const entry of marked) {
  const sliced = slices(replyToCheck(entry));
  for (const name of NAMES) {
    const slice = sliced[name];
    if (!slice) continue;
    const scores: number[] = [];
    for (let run = 0; run < runs; run++) {
      const score = (await decide(slice, { [name]: QUESTIONS[name] }, signal)).answers[name];
      if (score !== undefined) scores.push(score);
    }
    const tally = tallies[name];
    if (scores.length === 0) {
      tally.unanswered++;
      continue;
    }
    tally.scores.push(scores);
    const flagged = Math.max(...scores) >= CUT_OFFS[name];
    const slipped = entry.slips.includes(name);
    if (flagged && slipped) tally.caught++;
    if (!flagged && slipped) tally.missed++;
    if (flagged && !slipped) tally.falseAlarms++;
    // Ids and numbers only, so the output holds no story text.
    console.log(
      `${entry.save.slice(0, 8)} ${String(entry.reply).padStart(5)} ${name.padEnd(11)} ${scores.map((score) => score.toFixed(2)).join(" ")}${slipped ? "  (slip)" : ""}`,
    );
  }
}

const seconds = (Date.now() - started) / 1000;
console.log(
  `\n${settings.read().consistencyModel}: ${marked.length} replies, $${cost.toFixed(4)} in all, ${(seconds / marked.length).toFixed(1)} s and $${(cost / marked.length).toFixed(5)} a reply`,
);
for (const name of NAMES) {
  const { caught, missed, falseAlarms, unanswered, scores } = tallies[name];
  const spread = runs > 1 ? `, widest spread between runs ${Math.max(0, ...scores.map((each) => Math.max(...each) - Math.min(...each))).toFixed(2)}` : "";
  console.log(`${name} (cut-off ${CUT_OFFS[name]}): caught ${caught}, missed ${missed}, false alarms ${falseAlarms}, unanswered ${unanswered}${spread}`);
}
