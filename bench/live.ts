// A live play: an agent plays a story Turn by Turn, steering it by what it reads, to find how good the story is and what breaks
// (bench/LIVE.md). `bun bench live` holds the play open; `bun bench do` sends one action and prints only what a player would see,
// as everything it prints comes from the routes the story screen uses, never from the Save.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CONTINUE } from "../src/prompt-assembler";
import { TONES, toneText } from "../src/tones";
import { ART_STYLES } from "../src/web/art-styles";
import { blank, THEMES } from "../src/web/wizard-draft";

export type Sent = { ok: boolean; status: number; answer: string; offered?: string[]; message?: number; mark?: string };
export type LivePlay = {
  /** The app's own server, whose routes hide what a player mustn't see. */
  url: URL;
  id: string;
  folder: string;
  /** Turns the player may play. */
  turns: number;
  /** Rounds the story already had, when it goes on from a kept one. */
  first: number;
  /** Whether pictures are really drawn, so worth a look. */
  draw: boolean;
  send: (round: number, action: string, path: string, body: object, input?: string) => Promise<Sent>;
  /** Saves the play and ends it. */
  finish: () => void;
};

/** Holds the address `bun bench do` sends to, in the play's folder while it's open. */
export const liveFile = (folder: string) => join(folder, "live.json");

const Ask = z.object({ tool: z.string(), arg: z.string().default(""), text: z.string().default(""), note: z.string().default("") });
type Ask = z.infer<typeof Ask>;
/** A request to the app: where and what, the words for the timeline, the mark a reply it rewrote carries, and whether its answer is text to read. */
type Request = { path: string; body: object; input?: string; mark?: string; show?: boolean };
type Message = { id: number; role: string; text: string };

const TURN_TOOLS = ["move", "choose", "continue"];
const WORDS_TOOLS = [...TURN_TOOLS, "rewrite", "edit", "tell", "picture", "ask", "decide", "journal-edit", "rename", "finish"];
// The bench's own names for these steps, as the coverage, the state checks and the transcript know them.
const STEP_NAMES: Record<string, string> = { choose: "choice", tell: "worldChange" };
const TOOLS = `Turns (each needs a note): move (your words on stdin), choose <1-3>, continue
Other actions: rewrite (what to change on stdin), regenerate, edit (the reply's whole new text on stdin),
  tell (Tell the Narrator: a change to the world on stdin), revert <M>, picture (what to draw on stdin, or nothing for the scene), chapter,
  ask (a question on stdin), decide (a draft move on stdin, or nothing), journal-edit (its JSON on stdin),
  rename ({"name": "...", "newName": "..."} on stdin), opening (only if the first one failed)
Looking: look, story, journal, inventory, setup, pictures
Ending: finish (your verdict on stdin)
A Turn's note goes on stdin too, after a line of ---`;

const pickOne = <T>(items: T[]) => items[Math.floor(Math.random() * items.length)]!;

/** A story as a new player gets it with Pick for me: a theme and Tone at random, unless a theme is named, and the world the app builds. Gives its Save's id. */
export async function randomStory(url: URL, themeName = pickOne(Object.keys(THEMES))) {
  const toneName = pickOne(["", ...Object.keys(TONES)]);
  const theme = `${themeName}: ${THEMES[themeName]}`;
  const artStyle = `${blank.artStyle}: ${ART_STYLES[blank.artStyle]}`;
  const post = async (path: string, body: object) => {
    const headers = { "Content-Type": "application/json" };
    const response = await fetch(new URL(path, url), { method: "POST", headers, body: JSON.stringify(body), timeout: false });
    if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
    return (await response.json()) as Record<string, string>;
  };
  const { title, worldBrief, startingHook, inventory, ...pc } = await post("/worlds/pick", {
    theme,
    title: "",
    worldBrief: "",
    startingHook: "",
    pc: blank.pc,
  });
  const choices = { title, theme, tone: toneText(toneName, ""), worldBrief, startingHook, artStyle };
  const world = await post("/worlds", { ...choices, pc, inventory });
  return (await post(`/worlds/${world.id}/begin`, { artStyle })).id!;
}

/** The actions and looks of a live play. Each gives the text to print. */
export function livePlay({ url, id, folder, turns, first, draw, send, finish }: LivePlay) {
  let played = 0;
  let busy = false;
  let ended = false;
  const shown = new Set<string>();

  async function get<T>(path: string) {
    return (await (await fetch(new URL(`/saves/${id}${path}`, url))).json()) as T;
  }
  const read = () => get<{ messages: Message[]; choices?: string[] }>("/messages");
  const latestReply = async () => (await read()).messages.findLast(({ role }) => role === "narrator");
  const label = (message: Message) => `${message.role === "player" ? "You" : "Story"} (M${message.id}): ${message.text}`;

  /** The pictures drawn since last asked, saved to look at. */
  async function pictures() {
    if (!draw) return "";
    const lines: string[] = [];
    const { images } = await get<{ images: { kind: string; ref: number; label: string; redraws: number }[] }>("/gallery");
    for (const { kind, ref, label: caption, redraws } of images) {
      const key = `${kind}-${ref}-${redraws}`;
      const path = { cover: "/cover", portrait: `/portraits/${ref}`, scene: `/messages/${ref}/image`, requested: `/requested-images/${ref}/image` }[kind];
      if (!path || shown.has(key)) continue;
      const response = await fetch(new URL(`/saves/${id}${path}`, url));
      if (!response.ok) continue;
      shown.add(key);
      mkdirSync(join(folder, "seen"), { recursive: true });
      const file = join(folder, "seen", `${key}.png`);
      writeFileSync(file, await response.bytes());
      lines.push(`New picture, ${kind}${kind === "scene" ? ` of M${ref}` : ""}, "${caption}": ${file}`);
    }
    const { failure } = await get<{ failure?: string }>("/requested-images/failure");
    if (failure) lines.push(`The picture you asked for failed: ${failure}`);
    return lines.join("\n");
  }

  async function look() {
    const { messages, choices } = await read();
    const reply = messages.findLast(({ role }) => role === "narrator");
    const { offer } = await get<{ offer: boolean }>("/chapters");
    const { unmade } = await get<{ unmade?: number }>("/remakes");
    // Asked for now and then, as what a reader waits to find out says more of a story's pull than whether it was liked.
    const pull = played > 0 && played % 5 === 0 ? " In your next note, also say: would you put the story down here, and what are you waiting to find out?" : "";
    return [
      reply ? label(reply) : "The story hasn't begun: send opening.",
      choices ? `Choices:\n${choices.map((choice, at) => `${at + 1}. ${choice}`).join("\n")}` : "No Choices were offered: move or continue.",
      unmade ? "A change you told the Narrator of couldn't be made again after the Revert: tell it again." : "",
      offer ? "The app offers to end the chapter here (chapter)." : "",
      await pictures(),
      `Turns left: ${turns - played}.${pull}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const LOOKS: Record<string, () => Promise<string>> = {
    look,
    story: async () => (await read()).messages.map(label).join("\n\n"),
    journal: async () => {
      const { fullLog: _log, portraits: _portraits, ...journal } = await get<Record<string, unknown>>("/journal");
      return JSON.stringify(journal, null, 1);
    },
    inventory: async () => JSON.stringify({ ...(await get<object>("/inventory")), ...(await get<object>("/status")) }, null, 1),
    setup: async () => JSON.stringify(await get("/setup"), null, 1),
    pictures: async () => (await pictures()) || "No new pictures.",
  };

  /** What to send for a tool, or why nothing can be. */
  async function request({ tool, arg, text }: Ask): Promise<string | Request> {
    const onReply = async (replace: (message: number) => Request) => {
      const reply = await latestReply();
      return reply ? replace(reply.id) : "There's no reply yet.";
    };
    switch (tool) {
      case "opening":
        return (await latestReply()) ? "The story has begun already." : { path: "/opening", body: {} };
      case "move":
        return text ? { path: "/turns", body: { input: text }, input: text } : "Give your move on stdin.";
      case "continue":
        return { path: "/turns", body: { input: CONTINUE }, input: CONTINUE };
      case "choose": {
        const choice = (await read()).choices?.[Number(arg) - 1];
        return choice ? { path: "/turns", body: { input: choice }, input: choice } : "There's no such Choice.";
      }
      case "rewrite":
        if (!text) return "Say what to change on stdin.";
        return onReply((at) => ({ path: `/messages/${at}/rewrite`, body: { feedback: text }, input: text, mark: `The player's Rewrite asked: "${text}"` }));
      case "regenerate":
        return onReply((at) => ({ path: `/messages/${at}/regenerate`, body: {}, mark: "Written again by the player's Regenerate" }));
      case "edit":
        if (!text) return "Give the reply's whole new text on stdin.";
        return onReply((at) => ({ path: `/messages/${at}/edit`, body: { text }, mark: "The player's own Edit of this reply" }));
      case "tell":
        return text ? { path: "/world-change", body: { change: text }, input: text } : "Say what changes on stdin.";
      case "revert":
        // Only to a reply, as the app too goes back past the player's own words, so none is left unanswered.
        return (await read()).messages.some(({ id: at, role }) => role === "narrator" && `M${at}` === arg)
          ? { path: `/messages/${arg.slice(1)}/revert`, body: {}, input: arg }
          : "Give the reply to go back to, one of the story's own, such as M12.";
      case "picture":
        if (!draw) return "Pictures aren't drawn in this play.";
        return { path: "/requested-images", body: { words: text }, input: text };
      case "chapter":
        return { path: "/chapters", body: {} };
      case "ask":
        return text ? { path: "/questions", body: { question: text }, input: text, show: true } : "Give your question on stdin.";
      case "decide":
        return { path: "/decide", body: { draft: text }, show: true };
      case "journal-edit":
      case "rename":
        try {
          return { path: tool === "rename" ? "/rename" : "/edits", body: JSON.parse(text) as object, input: text };
        } catch {
          return "Give its JSON on stdin.";
        }
      default:
        return TOOLS;
    }
  }

  async function act(ask: Ask) {
    const { tool, arg, note } = ask;
    const turn = TURN_TOOLS.includes(tool);
    if (turn && played >= turns) return "The play's Turns are used up: finish, with your verdict on stdin.";
    if (turn && !note) return "Add a note on stdin, after a line of ---: how the last reply felt and why, and what you expect next.";
    const asked = await request(ask);
    if (typeof asked === "string") return asked;
    const number = played + (turn ? 1 : 0);
    const after = (await latestReply())?.id ?? 0;
    const { choices } = await read();
    const sent = await send(first + number, STEP_NAMES[tool] ?? tool, `/saves/${id}${asked.path}`, asked.body, asked.input);
    if (!sent.ok) return `The app said: ${errorOf(sent.answer) || "nothing, it couldn't be reached"} (${sent.status}). You can send it again.`;
    // Only once it was played, so a Turn that failed can be sent again.
    if (turn) {
      played++;
      sent.offered = choices;
      appendFileSync(join(folder, "notes.md"), `## Turn ${number}, after M${after}: ${[tool, arg].join(" ").trim()}\n\n${note}\n\n`);
    }
    if (asked.mark) Object.assign(sent, { mark: asked.mark, message: (await latestReply())?.id });
    if (asked.show) return (JSON.parse(sent.answer) as { text: string }).text;
    return tool === "picture" ? "It's being drawn, and shows with a later action." : look();
  }

  return {
    /** Turns played so far. */
    played: () => played,
    async do(body: unknown) {
      const parsed = Ask.safeParse(body);
      if (!parsed.success) return TOOLS;
      const ask = parsed.data;
      if (ended) return "The play has finished.";
      const looked = LOOKS[ask.tool];
      if (looked) return looked();
      if (busy) return "The last action is still going: wait for it.";
      if (ask.tool === "finish") {
        if (!ask.text) return "Give your verdict on stdin.";
        writeFileSync(join(folder, "verdict.md"), `${ask.text}\n`);
        ended = true;
        finish();
        return "Finished. The play is being saved.";
      }
      busy = true;
      try {
        return await act(ask);
      } finally {
        busy = false;
      }
    },
  };
}

function errorOf(answer: string) {
  try {
    return (JSON.parse(answer) as { error?: string }).error ?? answer;
  } catch {
    return answer;
  }
}

/** `bun bench do <folder> <tool> [arg]`, with the words on stdin, then a note after a line of ---. */
export async function sendAction(folder: string | undefined, tool = "", arg = "") {
  if (!folder || !existsSync(folder)) return "Give the play's folder, then a tool.";
  if (!existsSync(liveFile(folder))) return "No play is open there: it is still starting, or it has finished.";
  const { url } = JSON.parse(readFileSync(liveFile(folder), "utf8")) as { url: string };
  // Not for a tool that takes no words, as a shell may leave stdin open and the read would never end.
  const words = process.stdin.isTTY || !WORDS_TOOLS.includes(tool) ? "" : await Bun.stdin.text();
  // Only a Turn has a note, as a verdict or a reply's new text may hold such a line of its own.
  const [text = "", ...note] = TURN_TOOLS.includes(tool) ? words.split(/^---[ \t]*\r?$/m) : [words];
  try {
    const body = JSON.stringify({ tool, arg, text: text.trim(), note: note.join("---").trim() });
    return await (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, timeout: false })).text();
  } catch {
    return "The play can't be reached: it has stopped.";
  }
}
