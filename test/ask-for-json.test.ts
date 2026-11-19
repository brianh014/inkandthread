import { expect, test } from "bun:test";
import { z } from "zod";
import { askForJson, type TextProvider, ThinkingBudgetReached, ThoughtTooLong } from "../src/turn-engine";

/** Answers with each reply in turn, keeping what each try was sent. */
function scripted(...replies: (string | Error)[]) {
  const tries: { prompt: Parameters<TextProvider>[0]; lessThinking: number | undefined }[] = [];
  const provider: TextProvider = async (prompt, request) => {
    tries.push({ prompt, lessThinking: request.lessThinking });
    const reply = replies.shift()!;
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { provider, tries };
}
const Reply = z.object({ text: z.string().refine((text) => text.length <= 5, "over 5 letters") });
const ask = (provider: TextProvider) => askForJson(provider, [{ role: "user", content: "Hi" }], Reply, "refused", new AbortController().signal);

test("a retry tells the model why its last reply couldn't be used, after the prompt and never quoting it", async () => {
  const { provider, tries } = scripted(JSON.stringify({ text: "far too long" }), JSON.stringify({ text: "short" }));

  expect(await ask(provider)).toEqual({ text: "short" });
  expect(tries[0]!.prompt).toHaveLength(1);
  const note = tries[1]!.prompt.at(-1)!.content;
  expect(tries[1]!.prompt[0]!.content).toBe("Hi");
  expect(note).toContain("text: over 5 letters");
  expect(note).not.toContain("far too long");
});

test("a reply that thought too long is asked again a Thinking level lower each time", async () => {
  const overthought = () => new ThoughtTooLong("thought too long");
  const { provider, tries } = scripted(overthought(), overthought(), JSON.stringify({ text: "ok" }));

  expect(await ask(provider)).toEqual({ text: "ok" });
  expect(tries.map(({ lessThinking }) => lessThinking)).toEqual([0, 1, 2]);
  expect(tries[2]!.prompt).toHaveLength(1);
});

test("a reply stopped at its thinking budget is asked again at the same level, told to answer now", async () => {
  const { provider, tries } = scripted(new ThinkingBudgetReached("budget"), JSON.stringify({ text: "ok" }));

  expect(await ask(provider)).toEqual({ text: "ok" });
  expect(tries.map(({ lessThinking }) => lessThinking)).toEqual([0, 0]);
  expect(tries[1]!.prompt.at(-1)!.content).toContain("give it now");
});
