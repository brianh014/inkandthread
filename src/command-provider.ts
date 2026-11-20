import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "./logger";
import type { Prompt } from "./prompt-assembler";
import { modelName } from "./settings-store";
import { type TextProvider, TextProviderFailed } from "./turn-engine";

// The player sees these with a retry hint after them, so none ends in a full stop.
const CANT_RUN = "The command in Settings can't be run, so check its program name and that the program is installed";
const TOO_LONG = "The command ran past the reply time limit in Settings and was stopped, so nothing was saved";
const SILENT = "The command printed nothing, so try it by hand with a short prompt on its input";
const exitedWith = (code: number) => `The command stopped with exit code ${code}, so try it by hand, or check its limits haven't run out`;

/** The prompt as plain text, each message under its role, with the reply's schema last when the prompt doesn't already give it. */
export function commandInput(prompt: Prompt, schema?: object) {
  const text = prompt.map(({ role, content }) => `[${role}]\n${content}`).join("\n\n");
  const shape = schema && JSON.stringify(schema);
  return shape && !text.includes(shape) ? `${text}\n\nReply only with JSON matching this schema: ${shape}` : text;
}

/**
 * One reply from the player's command: the prompt on its stdin, the reply streamed from its stdout. A non-zero exit, no
 * output, the reply time limit or a stop ends it, and the program is killed on a stop. Stderr is logged by length only, as
 * it may echo the prompt.
 */
export async function commandReply(
  prompt: Prompt,
  { schema, onText, signal }: Parameters<TextProvider>[1],
  { textCommand: command, textReplyMinutes, storyInLog }: { textCommand: string[]; textReplyMinutes: number; storyInLog: boolean },
) {
  if (storyInLog) log.story("text", "Prompt text", { prompt });
  const started = Date.now();
  // For the Server Log, so it holds how the call went and none of its text.
  const outcome: { program: string; exit?: number; stderrChars?: number; failed?: string } = { program: modelName({ textCommand: command, textModel: "" }) };
  // From the start, as a program that prints its reply in one go is silent until it ends.
  const overrun = AbortSignal.timeout(textReplyMinutes * 60 * 1000);
  const stop = AbortSignal.any([signal, overrun]);
  // Empty, so a CLI that reads or changes its working folder finds nothing of Ink & Thread's, its keys and Saves among them.
  const folder = mkdtempSync(join(tmpdir(), "inkandthread-command-"));
  let reply = "";
  let child: ReturnType<typeof Bun.spawn> | undefined;
  // On Windows a .cmd program is started through cmd.exe, so the whole tree is ended, or the real program would run on.
  const kill = () => {
    if (!child) return;
    if (process.platform === "win32") Bun.spawn(["taskkill", "/pid", String(child.pid), "/t", "/f"], { stdio: ["ignore", "ignore", "ignore"] });
    else child.kill();
  };
  try {
    stop.throwIfAborted();
    try {
      child = Bun.spawn(command, { cwd: folder, stdin: new Blob([commandInput(prompt, schema)]), stdout: "pipe", stderr: "pipe" });
    } catch (cause) {
      throw new TextProviderFailed(CANT_RUN, { cause });
    }
    stop.addEventListener("abort", kill, { once: true });
    const errors = new Response(child.stderr as ReadableStream).text();
    try {
      // Ended by the stop too, as a child the killed program left behind can hold its output open.
      for await (const text of (child.stdout as ReadableStream).pipeThrough(new TextDecoderStream(), { signal: stop })) {
        reply += text;
        onText(text);
      }
    } catch (cause) {
      if (!stop.aborted) throw cause;
    }
    outcome.exit = await child.exited;
    outcome.stderrChars = (await errors).length;
    signal.throwIfAborted();
    if (overrun.aborted) throw new TextProviderFailed(TOO_LONG);
    if (outcome.exit !== 0) throw new TextProviderFailed(exitedWith(outcome.exit));
    if (!reply.trim()) throw new TextProviderFailed(SILENT);
    return reply;
  } catch (cause) {
    outcome.failed = signal.aborted ? "stopped" : overrun.aborted ? "time limit" : (cause as Error).name;
    throw cause;
  } finally {
    stop.removeEventListener("abort", kill);
    try {
      rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Windows keeps a folder a killed program's child still sits in, and an empty temporary folder left behind is harmless.
    }
    const logAs = outcome.failed && !signal.aborted ? log.warning : log.info;
    logAs("text", "Command reply", { ...outcome, chars: reply.length, ms: Date.now() - started });
    if (storyInLog && reply) log.story("text", "Text reply text", { text: reply });
  }
}
