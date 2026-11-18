// A stand-in for a provider's CLI: `bun test/fake-command.ts <rules.json>`. It reads the prompt on stdin, keeps it in
// `<rules.json>.inputs`, then follows the first rule whose `when` is in the prompt (or has none): it prints `reply`, exits
// with `exit`, or with `hang` prints its pid to `<rules.json>.pid` and waits forever.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

type Rule = { when?: string; reply?: string; exit?: number; hang?: boolean };

const rulesFile = process.argv[2]!;
const input = await new Response(Bun.stdin.stream()).text();
appendFileSync(`${rulesFile}.inputs`, `${input}\n=====\n`);
const rules = JSON.parse(readFileSync(rulesFile, "utf8")) as Rule[];
const rule = rules.find(({ when }) => !when || input.includes(when)) ?? { exit: 9 };
if (rule.hang) {
  writeFileSync(`${rulesFile}.pid`, String(process.pid));
  // A timer, as a promise alone wouldn't keep the process running.
  setInterval(() => {}, 60_000);
  await new Promise(() => {});
}
// In two parts, so streaming is seen.
const reply = rule.reply ?? "";
process.stdout.write(reply.slice(0, reply.length / 2));
await Bun.sleep(5);
process.stdout.write(reply.slice(reply.length / 2));
process.exit(rule.exit ?? 0);
