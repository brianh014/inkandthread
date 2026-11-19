import { z } from "zod";
import { type Check, CheckRequest, type Dice, resolveCheck } from "./check-resolver";
import { type ImagePipeline, movedScene, portraitsDue, restyledBy, type Scene } from "./image-pipeline";
import { promptStyle } from "./graph-builder";
import { withArtStyleFor } from "./web/art-styles";
import { errorFields, errorType, log } from "./logger";
import {
  assemblePrompt,
  chapterTitlePrompt,
  isContinueInput,
  editInstruction,
  journalChange,
  memoryDue,
  memoryPrompt,
  OPENING_INPUT,
  REPLY_WORDS,
  plainMessage,
  type Prompt,
  replacementInstruction,
  resultInstruction,
  SET_SCENE_NOTE,
} from "./prompt-assembler";
import { type Message, type PlayMode, type Reply, type SaveStore, StaleTurn } from "./save-store";
import type { SettingsStore } from "./settings-store";
import type { NarratorTurn, UsageStore } from "./usage-store";
import {
  applyOperations,
  closestThread,
  findPerson,
  givenName,
  introduce,
  MAX_PLOT_THREADS,
  nameForms,
  Person,
  type SceneMemory,
  type State,
  StateOperation,
} from "./state-applier";
import { type Checked, type Consistency, checkConsistency, replyToCheck } from "./consistency";
import { countWords, withinLimit } from "./limits";
import { knownChoices, withoutUnread, writeChoices } from "./known-choices";
import { wholeWord } from "./lore-activation";
import { type Upkeep, upkeepOperations } from "./state-upkeep";
import { readable, withoutStrayMarks } from "./web/chat-style";
import { applyWorldChange } from "./world-creation";
import { askToClose, MOVE_LIMIT, moveDue, moveWorldOn, turnThreadChanges } from "./world-moves-on";

// Each Save's move of the world still running, which the next Turn waits for, so it reads the world as moved.
const moving = new Map<string, Promise<void>>();

/** The token counts and cost a server reports for one reply, in the OpenAI shape. OpenRouter adds `cost`. */
export type TextUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  cost?: number;
};

/** Throws ContentRefused when the content is refused. Anything else it throws is a network or API error. */
export type TextProvider = (
  prompt: Prompt,
  /**
   * `onGeneration` hears the provider's id for this reply, the one way to find a reply no Save keeps.
   * `onUsage` hears what the server reported the reply used, if it did: once the call ends, or later for a reply that
   * ended before its usage came.
   */
  request: {
    schema?: object;
    /** What the call is for, such as "turn" or "upkeep", a fixed name for the log's "Text reply", so token use can be told apart. */
    call?: string;
    /** An Image Prompt's call, which has its own thinking limit. */
    picture?: boolean;
    /** How many levels below the player's Thinking to ask for, after a reply thought past the limit. */
    lessThinking?: number;
    /**
     * Tokens of thinking, sent in place of the level to a model whose provider takes a budget, for a call with a hard time limit.
     * For any other model, the stream is stopped with ThinkingBudgetReached once it has thought for `thinkingMs` from its first thinking token.
     */
    thinkingBudget?: number;
    thinkingMs?: number;
    onText: (text: string) => void;
    onGeneration?: (id: string) => void;
    onUsage?: (usage: TextUsage) => void;
    /** Hears the id this call's log lines carry, before it is sent, so a line about its reply can name it too. */
    onCall?: (id: string) => void;
    signal: AbortSignal;
  },
) => Promise<string>;

/** `reply` carries the reply's final text, sent before its follow-ups (State Upkeep, Choices) run, and never changed after. */
export type TurnEvents = (event: "narration" | "restart" | "revise" | "reply", data: object) => void;

/** When a reply's work began, and how long each follow-up took once the reply was shown, for the Server Log. */
type FollowUpTimes = { started: number; upkeep?: number; choices?: number };

export class ContentRefused extends Error {}
/** A failure whose message is fit to show the player. */
export class TextProviderFailed extends Error {}
/** A reply that sent nothing at all, neither text nor thinking, before the silence limit. */
export class SilentFromStart extends TextProviderFailed {}
/** The reply reached the token limit and was cut off. */
export class ReplyCutOff extends TextProviderFailed {}
/** A model stuck thinking, which a fresh try mostly isn't, so every call retries it. */
export class ThoughtTooLong extends ReplyCutOff {
  override name = "ThoughtTooLong";
}
/** A call thought past the budget it was given, which its model couldn't take as a parameter, so the stream was stopped. */
export class ThinkingBudgetReached extends ReplyCutOff {
  override name = "ThinkingBudgetReached";
}
class InvalidResponse extends Error {}

/** An abort reason for a reply stopped on purpose, as it has given all that's needed: logged by its words, and never a failure. */
export class StoppedOnPurpose {
  constructor(readonly why: string) {}
}

const RAN_ON = "ran on far too long";
const OVERTHOUGHT = "thought far too long";
// Told to the model as the reason, so it answers at once: a call that already thought at length mostly has its answer.
const OVER_BUDGET = "you thought past the time this answer has, so give it now with little or no more thinking";
const RATED = "rated for a Check, so the rest isn't needed";
const DECLINED_MESSAGE =
  "The AI wouldn't write how this turned out, which usually means its content rules block it. Nothing was saved: try another move, or another AI.";
// Twice the longest real reply in players' logs, so only a model stuck in a loop reaches it, long before the token limit. An
// opening introduces the world's people and places, so it gets twice as much. Thinking a local model streams isn't counted.
// shortcut: one fixed size for every model, measured on one player's DeepSeek logs; make it a Setting if real replies reach it.
const RUNAWAY_CHARS = 24_000;

/** The Turn wrote nothing. `input` is the player's text, so they can edit it or send it again. */
export class TurnFailed extends Error {
  constructor(
    message: string,
    readonly failure: "refused" | "retryable",
    readonly input: string,
    options: ErrorOptions,
  ) {
    super(message, options);
  }
}

// set_summary was offered once, and a model that still sends it, such as one with no schema mode, only repeats the summary field.
// A Turn no longer adds a Plot Thread, which is World Moves On's: Turns added threads that restated what the PC knew or were
// the PC's own goals. A model that still sends one has it dropped, not the reply.
const RETIRED = ["set_summary", "add_plot_thread"];
// DeepSeek filled its operations with placeholders, such as resolving a thread named "x", "none" or "", which failed whole Turns,
// and saved an item named "x" and a known fact that was only a name, such as "Silas Grout", to the Journal.
const PLACEHOLDER = /^[\s_]*(?:none|nonexistent|unused|placeholder|n\/a|null|\p{L})?[\s_]*$/iu;
export const isJunk = (operation: Record<string, unknown>) =>
  Object.values(operation).some((value) => typeof value === "string" && PLACEHOLDER.test(value)) ||
  (operation.op === "add_known_fact" && typeof operation.fact === "string" && /^\p{Lu}\p{L}*(?:\s+\p{Lu}\p{L}*)+$/u.test(operation.fact.trim()));
/**
 * The operations without retired ones and placeholders. A reply's resolves go too when it resolves more than one thread, as
 * DeepSeek wiped every open thread at once, early and again later, with nothing ended; World Moves On removes what play has ended.
 * Its removes of Lore Entries likewise, as one reply wiped nine of the world's ten. Removing other records two at a time is
 * common in play, such as two items handed over, so only these two are held to one.
 */
export const usableOperations = (operations: unknown) => {
  if (!Array.isArray(operations)) return operations;
  const usable = operations.filter((operation) => !RETIRED.includes(operation?.op ?? "") && !(operation && typeof operation === "object" && isJunk(operation)));
  // How many of `op` the reply sent, or 0 when they name one record only.
  const many = (op: string, field: string) => {
    const removes = usable.filter((operation) => operation.op === op);
    return new Set(removes.map((operation) => operation[field])).size > 1 ? removes.length : 0;
  };
  const resolves = many("resolve_plot_thread", "thread");
  const loreRemoves = many("remove_lore_entry", "title");
  const kept = usable.filter(({ op }) => !(resolves && op === "resolve_plot_thread") && !(loreRemoves && op === "remove_lore_entry"));
  const dropped = operations.length - kept.length;
  if (dropped > 0) log.info("turn", "Operations dropped", { placeholders: operations.length - usable.length, resolves, loreRemoves });
  return kept;
};
const TurnOperation = z.discriminatedUnion(
  "op",
  StateOperation.options.filter(({ shape }) => !RETIRED.includes(shape.op.value)) as unknown as typeof StateOperation.options,
);

// Real replies held at most 16 operations, and openings 23; a model stuck in a loop sent up to 138, mostly one thread updated
// again and again. An opening gets twice as many, as it does twice the work.
const MAX_OPERATIONS = 30;
type TurnOperation = z.infer<typeof TurnOperation>;
// What an operation gives the record it names, so two that change one record are one however each words the change.
const NEW_VALUES = ["replacement", "now", "plan", "truth", "content", "keywords", "appearance", "summary"];
/**
 * The operations without a second of the same operation on the same record, such as a thread updated again, and at most
 * `limit` of them. An update then a resolve of one thread is kept, as the state applier follows it. A rewrite of what an earlier
 * one wrote goes too, so a record changes once, as a looping reply rewrote one thread 14 times, A to B to C, and lost what it hid.
 * shortcut: records are told apart by their exact words, so a loop that rewords its quote each time gets through; match them as closestThread does if that shows up.
 */
export function withoutLoop(operations: TurnOperation[], limit: number) {
  const seen = new Set<string>();
  return operations
    .filter((operation) => {
      const key = JSON.stringify(Object.entries(operation).filter(([field]) => !NEW_VALUES.includes(field)));
      if (seen.has(key)) return false;
      seen.add(key);
      if (operation.op !== "update_plot_thread" && operation.op !== "update_known_fact") return true;
      const [old, next] = operation.op === "update_plot_thread" ? [operation.thread, operation.truth] : [operation.fact, operation.replacement];
      // Each link's new words are noted even when it goes, so the rest of the chain goes too. A thread's identity is its truth.
      if (next && next !== old) seen.add(`${operation.op}\n${next}`);
      return !seen.has(`${operation.op}\n${old}`);
    })
    .slice(0, limit);
}
/**
 * A reply stopped as it ran on, closed after its last whole operation, when its narration came before its operations, as the
 * runaways were models repeating operations after a whole narration. What follows them, such as the summary, is lost.
 * shortcut: a "}," inside an operation's text would cut there; the cut reply then fails to parse and is written again, as before.
 */
export function closedAtLastOperation(reply: string) {
  const start = reply.indexOf('"state_operations"');
  const narration = reply.indexOf('"narration"');
  if (start < 0 || narration < 0 || narration > start) return undefined;
  const whole = reply.slice(start).match(/^[\s\S]*\}(?=\s*,)/)?.[0];
  return whole ? `${reply.slice(0, start)}${whole}]}` : undefined;
}
const FinishedTurn = z.object({
  // Whether it has words is checked once it's parsed, so a Check's result without any is told as declined.
  narration: z.string().trim().min(1),
  state_operations: z.preprocess(usableOperations, z.array(TurnOperation).default([])),
  people: z.array(Person).catch([]),
  summary: z.string().catch(""),
  recent_summary: z.string().nullish().catch(""),
  scene_changed: z.boolean().nullish(),
  visual_description: z.string().nullish(),
  chapter_ends: z.boolean().nullish(),
  // Without this, narration beside an invalid difficulty would pass as a finished Turn and dodge the Check.
  check: z.null().optional(),
  // Checked by usableChoices, as a reply with bad Choices still holds a Turn worth keeping.
  choices: z.unknown().optional(),
});
const NONE = "None";
// An action rated None needs no roll, so it reads as a finished Turn.
const unrated = (reply: unknown) =>
  (reply as { check?: { difficulty?: unknown } })?.check?.difficulty === NONE ? { ...(reply as object), check: null } : reply;
const NarratorResponse = z.preprocess(unrated, z.union([z.object({ check: CheckRequest }), FinishedTurn]));
/** The player wrote the narration of an Edit, so the reply holds only what follows from it. */
const EditedTurn = FinishedTurn.extend({ narration: z.string().nullish() });

/** A schema to send to a model. Strict schema modes refuse some keywords, so those are left to validating the reply. */
export function jsonSchemaOf(schema: z.ZodType) {
  const { $schema, ...sendable } = z.toJSONSchema(schema, {
    io: "output",
    override: ({ jsonSchema }) => {
      delete jsonSchema.minLength;
      delete jsonSchema.minItems;
      if (jsonSchema.oneOf) {
        jsonSchema.anyOf = jsonSchema.oneOf;
        delete jsonSchema.oneOf;
      }
    },
  });
  return sendable;
}

/**
 * `schema` with every thread an operation names held to the open truths, as models misquoted the long truths they were told to copy
 * and the change was lost. Only the sent schema, so a provider that ignores it still gets closestThread's match.
 */
export const threadsHeld = (schema: object, threads: string[]): object =>
  threads.length === 0
    ? schema
    : JSON.parse(JSON.stringify(schema), (key, value) => (key === "thread" && value?.type === "string" ? { ...value, enum: threads } : value));

// What the Narrator is asked for. It is flat because strict schema modes refuse a union at the root, and check
// comes first so that a streamed reply shows it is not a Check request before any narration arrives.
// Every action is rated, as a check the Narrator could leave null was left null even for a move that plainly needed one.
const ResponseShape = z.object({
  // Stakes before difficulty, as a model that went straight to a difficulty rated even a move it called unwarned Easy.
  check: z.object({
    action: CheckRequest.shape.action,
    stakes: z.string().describe("in a few words, what could go wrong, and how anyone it touches would truly take it"),
    // The odds beside the names, as a model that wrote stakes of real harm still chose Moderate, not knowing what it meant.
    difficulty: z
      .enum([NONE, ...CheckRequest.shape.difficulty.options])
      .describe(
        "from the stakes: None when it can't fail and nothing rides on it, Easy when it almost always works, Moderate when it's about even, Hard when it usually fails or would rarely be welcomed, Very Hard when only rare luck makes it work or welcome",
      ),
  }),
  narration: z.string().nullable(),
  state_operations: z.array(TurnOperation),
  // Described here for the same reason as chapter_ends: speakers kept going missing from it.
  people: z
    .array(Person)
    .describe(
      "everyone the narration names or gives a spoken line to, other than the PC, even someone only mentioned, each with their name and appearance. Someone new never gets a name, or a first name, that the PC or anyone in the state already has, as people are matched by name",
    ),
  summary: z.string(),
  recent_summary: z.string(),
  scene_changed: z.boolean().nullable(),
  // The length beside the field too, as the Narrator writes the people's looks itself and a rule mid-prompt gets ignored.
  visual_description: z
    .string()
    .nullable()
    .describe("the picture's prompt, written as the rules say and kept within their word limit with each person's looks counted in it"),
  // Defined here, beside the field, as a rule mid-prompt is the kind Narrators ignore.
  chapter_ends: z
    .boolean()
    .nullable()
    .describe(
      "true only when a Scene has just resolved and the story is about to move to a new place, a new time, or a new stage in a Plot Thread, which suggests ending the chapter here",
    ),
});
// Last, so the narration streams first. Only sent in Choices mode, and its rule is beside it, as a rule mid-prompt gets ignored.
export const CHOICES_RULE =
  "exactly three things the PC might say or do next, each one first-person sentence of at most 25 words, built only on what the replies show has happened and the PC knows, naming no event, place or thing they don't show, fitting what they now hold, wear and have just done, and each taking a clearly different approach, at most one of them only watching, waiting or carrying word to someone and at least one of them moving the story on toward what comes next that the PC knows of, such as setting out, acting on a plan, facing what waits or taking up what someone offers or the PC wants. Never hint at risk, difficulty, dice or a Check";
const ChoicesShape = ResponseShape.extend({ choices: z.array(z.string()).describe(CHOICES_RULE) });
// Once a Check is rolled, or none can be, the schema itself forbids one and asks for the story, as the prompt's "Do not request another check" was ignored three times running.
const SCHEMAS = {
  free: { any: jsonSchemaOf(ResponseShape), noCheck: jsonSchemaOf(ResponseShape.extend({ check: z.null(), narration: z.string() })) },
  choices: { any: jsonSchemaOf(ChoicesShape), noCheck: jsonSchemaOf(ChoicesShape.extend({ check: z.null(), narration: z.string() })) },
};

/**
 * A text field without JSON punctuation or invisible characters a model left at its end, such as `:null,`, `]]}` or `"],`.
 * A closing quote alone stays, as a Choice may end on speech, and one the marks took is put back when the text opened it, as is
 * a brace, as a picture's likeness sentence in braces ends its field.
 */
export function withoutJsonTail(text: string) {
  const visible = text.replace(/[​-‍⁠﻿]+$/u, "");
  const tail = visible.match(/(?::\s*null)?[\s"\]}{[,:​-‍⁠﻿]*$/u)![0];
  if (!/[\]}{[,:]/.test(tail)) return visible.trim();
  let kept = visible.slice(0, visible.length - tail.length).trim();
  if (tail.includes('"') && (kept.match(/"/g)?.length ?? 0) % 2 === 1) kept += '"';
  return tail.includes("}") && /\{[^{}]*$/.test(kept) ? `${kept}}` : kept;
}

/**
 * Three different Choices, or none if the reply hasn't that many. One-word Choices that differ only by a number at the end
 * count as one, as a model once offered "next", "next2" and "next3".
 */
/**
 * Without a Choice that names the PC, as one written as someone else, "I crouch beside Nell and tell her…", was offered to Nell
 * as her own move. The PC's name only with its capital, so a name that is also a word isn't taken for it. The rest stay, even
 * if fewer than three, as asking again costs a call for one bad Choice.
 */
function forThePc(choices: string[] | undefined, pcName: string) {
  if (!choices || !pcName) return choices;
  const names = [pcName, ...pcName.split(" ").filter((part) => part.length > 2 && /^\p{Lu}/u.test(part))];
  const kept = choices.filter((choice) => !names.some((name) => wholeWord(name, "u").test(choice)));
  if (kept.length < choices.length) log.info("turn", "Choices naming the PC dropped", { count: choices.length - kept.length });
  return kept.length > 0 ? kept : undefined;
}

export function usableChoices(choices: unknown) {
  const parsed = z.array(z.string()).safeParse(choices);
  const sameAs = (choice: string) => (/\s/.test(choice) ? choice : choice.replace(/\d+$/, ""));
  const byKind = new Map<string, string>();
  for (const choice of (parsed.data ?? []).map(withoutJsonTail)) if (/\p{L}/u.test(choice) && !byKind.has(sameAs(choice))) byKind.set(sameAs(choice), choice);
  const distinct = [...byKind.values()];
  return distinct.length >= 3 ? distinct.slice(0, 3) : undefined;
}
// A model that won't write a Check's result can't refuse in words when the provider holds it to the schema, so it sends
// something that isn't a story: replies came back as a lone comma, a single name and the rating written out.
const DECLINED = "a story the AI declined to write";
const RATING_TALK = /\bdifficulty\s*:\s*(?:none|easy|moderate|hard|very hard)\b|\bwhat['’]?s at stake\s*:/i;
const declined = (narration: string) => (narration.match(/\p{L}+/gu)?.length ?? 0) < 2 || RATING_TALK.test(narration);
// Words, not just punctuation, as a reply once came back as a lone comma.
const NO_WORDS = "a story with no words";
const hasWords = (narration: string) => /\p{L}{2}/u.test(narration);
// A reply once came back as "offer seen" and passed every check. The shortest real replies on the bench run past 80 words, and a
// short one that ends a sentence can still be a beat of story, so only a few words that end none are taken for a fragment.
// shortcut: by length and a closing mark; a fragment that ends in a full stop gets through, so add a word floor alone if one does.
const FRAGMENT = "a fragment far too short to be a reply";
const isFragment = (narration: string) => countWords(narration) < 15 && !/[.!?…]["”’)]?\s*$/u.test(narration);
// A result reply once came back as one line about the Turn awaiting its roll, shown as the story.
// Prose speaks of dice and turns too, as at a game, so only a short reply naming two of these, one of them the app's own
// reply, check or result, is taken for such a note.
const NOTE_ABOUT_TURN = "a note about the Turn instead of story";
const isNoteAboutTurn = (narration: string) => {
  const named = new Set(narration.toLowerCase().match(/\b(?:turn|reply|check|dice|roll|rolled|result)\b/g));
  return countWords(narration) < 30 && named.size >= 2 && ["reply", "check", "result"].some((word) => named.has(word));
};
// A reply once left a bare "state_operations:[]" line in its narration, which was saved as the story. The fields come after the
// narration, so such a line starts a tail that isn't story, and the narration ends before it. A line that starts with a field
// whose name no prose has, as "state_operations has more ops" did, needs no colon.
const FIELDS = Object.keys(ChoicesShape.shape);
const FIELD_LINE = new RegExp(String.raw`^\s*"?(?:(?:${FIELDS.join("|")})"?\s*:|(?:${FIELDS.filter((field) => field.includes("_")).join("|")})\b)`, "m");
// A reply also once ended its narration with its JSON's closing brace and a tool-call tag, as "}</arg_value>".
const JSON_TAIL = /\s*\}?(?:\s*<\/\w+>)*\s*$/;
// And once on a speaker tag with no words, which the tidying of marks keeps at the very end, as a tag still streaming.
const DANGLING_TAG = /\s*\n[ \t]*\[[^[\]\n]+\]:[ \t]*$/;
const withoutFields = (narration: string) => {
  const at = narration.search(FIELD_LINE);
  const story = at < 0 ? narration : narration.slice(0, at);
  // Whole JSON is left for isJsonObject to refuse.
  return story.trimStart().startsWith("{") ? story.trimEnd() : story.replace(JSON_TAIL, "").replace(DANGLING_TAG, "");
};
// A model once put its Check request in narration, which was saved as the story.
const JSON_NARRATION = "JSON for narration";
const isJsonObject = (narration: string) => {
  const text = narration.trim();
  if (!text.startsWith("{")) return false;
  try {
    return typeof JSON.parse(text) === "object";
  } catch {
    return false;
  }
};

// The check a reply opens with: null, or the rating's flat object of strings. One pattern, so streaming and the early stop agree.
// shortcut: a reply in another key order or after prose shows no narration until the Turn is done, loosen this only if real models do that often.
const OPENING_CHECK = String.raw`^\s*(?:\x60\x60\x60(?:json)?\s*)?\{\s*"check"\s*:\s*(null|\{(?:\s*"[a-z_]+"\s*:\s*"(?:[^"\\]|\\.)*"\s*,?)*\s*\})`;
const CHECK_START = new RegExp(OPENING_CHECK);
const NARRATION_START = new RegExp(String.raw`${OPENING_CHECK}\s*,\s*"narration"\s*:\s*"`);
// biome-ignore lint/suspicious/noControlCharactersInRegex: JSON strings may not hold raw control characters, so this matches what they can.
const COMPLETE_JSON_CHARACTERS = /^(?:[^"\\\x00-\x1f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*/;

// A model's thoughts can hold stray JSON, or a draft that differs from its reply. A chat template may supply the
// opening tag, and a reply can be cut off before the closing one.
const withoutThinking = (reply: string) => reply.replace(/^[\s\S]*<\/think>/, "").replace(/<think>[\s\S]*$/, "");

/** The check a visible reply opens with, once it's complete: null, or the rating as sent. Undefined until then. */
function openingCheck(reply: string): unknown {
  const found = reply.match(CHECK_START)?.[1];
  if (!found) return undefined;
  try {
    return JSON.parse(found);
  } catch {
    return undefined;
  }
}

const isNone = (opened: unknown) => opened === null || (opened as { difficulty?: unknown }).difficulty === NONE;

/** The narration in a visible reply whose check is known to be None or null. */
function narrationSoFar(reply: string) {
  const start = reply.match(NARRATION_START);
  if (!start) return "";
  return JSON.parse(`"${reply.slice(start[0].length).match(COMPLETE_JSON_CHARACTERS)![0]}"`) as string;
}

// The first try plus two automatic retries.
const MAX_ATTEMPTS = 3;

type Narrated = {
  /** For the Server Log. */
  kind: "turn" | "opening" | "rewrite" | "regenerate" | "edit";
  prompt: Prompt;
  /** The text a failure hands back to the player. */
  input: string;
  refusal: string;
  pcName: string;
  /** The PC's looks as the story began, which pcAppearance in the state replaces once set. */
  pcTraits: string;
  /** The state the reply starts from. */
  before: State;
  /** Left out when there's no reviewer to keep the state, as in a test's script. */
  upkeep?: Upkeep;
  /** Left out for an Edit, which is the player's own words. */
  consistency?: Consistency;
  /** The Narrator's last reply before this one, which the questions check this one against. */
  previous?: string;
  /** All the player has read so far, the Starting Hook and the Messages, so a Choice is never built on what the PC hasn't. Built only when asked, as a long story's is large. */
  seen?: () => string;
  /** For the opening, the Important Characters its Starting Hook names, whom it must bring on, as an opening that skipped them left the plot they seed unplayed. */
  mustMeet?: string[];
  /** The player's own words for an Edit, which stand in for whatever narration the reply holds. */
  narration?: string;
  check?: Check;
  /** The Scene Memory this Turn adds, if one is due and came back. */
  memory: Promise<SceneMemory | null>;
  /** Left out when no new roll is allowed, which makes a Check request an invalid reply. */
  rollCheck?: (request: z.infer<typeof CheckRequest>) => Check;
  playMode: PlayMode;
  commit: (narration: string, check: Check | undefined, advance: (state: State) => State, choices: string[] | undefined) => Reply[];
  /** Runs once the Turn is committed, so image work is never part of its transaction. */
  committed: (messageId: number, scene: Scene) => void;
  /** Tallies a committed player's Turn for the Narrator report. */
  counted?: (turn: NarratorTurn) => void;
  /** The open threads a committed reply asked to close, for World Moves On to weigh. */
  askClose?: (threads: string[], rewrites: (readonly [string, string])[]) => void;
  times: FollowUpTimes;
};

/** The prompt for a Turn's reply, and the Scene Memory due alongside it. Settings are read once, so the whole prompt comes from one copy. */
function turnPrompt(
  saves: SaveStore,
  settings: SettingsStore,
  id: string,
  signal: AbortSignal,
  textProvider: TextProvider,
  {
    state,
    messages,
    input,
    directions,
    journalEdits,
    picture,
  }: Pick<Parameters<typeof assemblePrompt>[0], "state" | "messages" | "input" | "directions" | "journalEdits"> & { picture: boolean },
) {
  const current = settings.read();
  const memoryStart = saves.memoryStart(id);
  const save = saves.read(id);
  return {
    playMode: save.playMode,
    prompt: assemblePrompt({
      save: withArtStyleFor(save, current),
      state,
      messages,
      memoryStart,
      windowMessages: current.textRecentMessages,
      modelInstructions: current.modelInstructions,
      imageInstructions: current.imageInstructions,
      directions,
      journalEdits,
      memoryTimes: saves.storyTimesAt(
        id,
        state.sceneMemories.map(({ firstMessage }) => firstMessage),
      ),
      input,
      // shortcut: the schema is in the cached start of the prompt, so switching Play Mode costs one uncached Turn. Move the choices rule below the cache if players switch often.
      responseSchema: JSON.stringify(SCHEMAS[save.playMode].any),
      promptStyle: picture ? promptStyle(current) : null,
    }),
    memory: nextMemory(textProvider, messages, state.sceneMemories, memoryStart, current.textRecentMessages, signal),
  };
}

const lastNarration = (messages: Message[]) => messages.findLast(({ role }) => role === "narrator")?.text ?? "";

/**
 * Waits for the Save's move of the world still running, if any, so what follows reads the world as moved: a World Change read
 * alongside one rewrote a thread the move had just rewritten, which came out twice. Stop ends the wait, as a move can run two minutes.
 */
export async function worldMoved(id: string, signal: AbortSignal) {
  const move = moving.get(id);
  signal.throwIfAborted();
  if (!move) return;
  log.info("world", "Waiting for the world to move on");
  await Promise.race([move, new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
  signal.throwIfAborted();
}

/** Logs once a committed reply's pictures and any World Moves On are done, with each follow-up's time. Never throws, as the Turn is saved. */
function followedUp(id: string, kind: string, images: ImagePipeline, times: FollowUpTimes) {
  const from = Date.now();
  const since = () => Date.now() - from;
  const took = (work: Promise<unknown>) => work.then(since, since);
  const move = moving.get(id);
  // shortcut: waits for every picture the Save has queued, a later Turn's too if the player moves on first; time per Turn if that muddles the log.
  void Promise.all([took(Promise.resolve().then(() => images.drawn(id))), move && took(move)]).then(([pictures, worldMoved]) =>
    log.info("turn", "Follow-ups done", { save: id, kind, ms: Date.now() - times.started, upkeep: times.upkeep, choices: times.choices, pictures, worldMoved }),
  );
}

/** What a World Change needs: the Narrator, the reviewer and the pictures a change can restyle. */
type WorldContext = { textProvider: TextProvider; settings: SettingsStore; images: ImagePipeline; reviewProvider?: TextProvider; consistency?: Consistency };

/**
 * Brings the hidden world in line with the player's Journal edits in a call of its own, as a Turn busy writing the
 * story can skip state changes. `stateOf` reads the state the reply starts from, and a stale request throws there,
 * before any call. Any other failure only skips it, as the reply is still told of the edits.
 */
async function settleJournal(saves: SaveStore, context: WorldContext, id: string, signal: AbortSignal, stateOf: () => State) {
  await worldMoved(id, signal);
  const change = journalChange(saves.pendingEdits(id));
  if (!change) return;
  stateOf();
  try {
    await applyWorldChange(context, saves, context.images, id, change, signal, { mayKeep: true, stateOf });
  } catch (error) {
    if (signal.aborted) throw error;
    log.warning("world", "Journal edits weren't settled before the Turn", errorType(error));
  }
}

export async function playTurn(
  saves: SaveStore,
  {
    textProvider,
    dice,
    nearMissMargin,
    settings,
    images,
    usage,
    reviewProvider,
    consistency,
    moveWorld,
  }: {
    textProvider: TextProvider;
    dice: Dice;
    nearMissMargin: number;
    settings: SettingsStore;
    images: ImagePipeline;
    usage?: UsageStore;
    reviewProvider?: TextProvider;
    consistency?: Consistency;
    /** Whether the world moves on at natural pauses. See `moveWorldOn`. */
    moveWorld?: boolean;
  },
  id: string,
  input: string,
  signal: AbortSignal,
  emit: TurnEvents = () => {},
  mayCheck = true,
) {
  const times = { started: Date.now() };
  await settleJournal(saves, { textProvider, settings, images, reviewProvider }, id, signal, () => saves.latestState(id));
  const basedOn = saves.latestMessageId(id);
  const state = saves.latestState(id);
  const messages = saves.messages(id);
  const { prompt, memory, playMode } = turnPrompt(saves, settings, id, signal, textProvider, {
    state,
    messages,
    input,
    directions: saves.directions(id, basedOn),
    journalEdits: saves.pendingEdits(id),
    picture: images.ready(),
  });
  const kind = input === OPENING_INPUT ? "opening" : "turn";
  // Read before the call, as it's the model asked. shortcut: a Rewrite, Regenerate, Edit or Revert keeps the first reply's counts (a Revert restarts the counts since), recount them if the report needs to match the story exactly.
  const model = settings.read().textModel;
  const played = await narrate(textProvider, signal, emit, {
    kind,
    prompt,
    input,
    refusal: "The Narrator refused this message. Edit it and try again.",
    pcName: saves.read(id).pc.name,
    pcTraits: saves.read(id).pc.physicalTraits ?? "",
    before: state,
    upkeep: reviewProvider && { provider: reviewProvider, settings, input },
    consistency,
    previous: lastNarration(messages),
    seen: () => [saves.read(id).startingHook ?? "", ...messages.map(({ text }) => text)].join("\n"),
    mustMeet:
      kind === "opening"
        ? (saves.read(id).importantCharacters ?? []).map(({ name }) => name).filter((name) => (saves.read(id).startingHook ?? "").includes(name))
        : [],
    memory,
    // The PC attempts nothing in a Continue, so there is nothing to roll for.
    rollCheck: mayCheck && !isContinueInput(input) ? (request) => resolveCheck(request, dice, nearMissMargin) : undefined,
    playMode,
    commit: (narration, check, advance, choices) => saves.commitTurn(id, basedOn, input, narration, check, advance, choices),
    committed: (messageId, scene) => images.sceneChanged(id, messageId, scene),
    // Only what the player did counts, so not the opening or a Continue, which have nothing to check.
    counted: kind === "turn" && !isContinueInput(input) ? (turn) => usage?.turn(id, model, turn) : undefined,
    askClose: (threads, rewrites) => askToClose(id, threads, rewrites),
    times,
  });
  const replies = messages.filter(({ role }) => role === "narrator").length + 1;
  if (moveWorld && kind === "turn" && moveDue(id, state, saves.latestState(id), replies)) {
    // Not awaited, as it runs while the player reads; its own signal, as the Turn's request has ended.
    const move = moveWorldOn(textProvider, settings, saves, id, AbortSignal.timeout(MOVE_LIMIT.ms)).finally(() => moving.delete(id));
    moving.set(id, move);
  }
  followedUp(id, kind, images, times);
  return played;
}

/** The Narrator's first Message, which the player has done nothing to earn a Check in. A story already open is stale. */
export function playOpening(saves: SaveStore, engine: Parameters<typeof playTurn>[1], id: string, signal: AbortSignal, emit?: TurnEvents) {
  if (saves.latestMessageId(id) !== 0) throw new StaleTurn();
  return playTurn(saves, engine, id, OPENING_INPUT, signal, emit, false);
}

/** Rewrite, when there is `feedback`, or Regenerate. Takes no Dice: the Turn's stored Check stands, and a Turn without one stays without. */
export async function replaceResponse(
  saves: SaveStore,
  { textProvider, settings, images, reviewProvider, consistency }: WorldContext,
  id: string,
  messageId: number,
  feedback: string | undefined,
  signal: AbortSignal,
  emit: TurnEvents = () => {},
) {
  const times = { started: Date.now() };
  await settleJournal(saves, { textProvider, settings, images, reviewProvider }, id, signal, () => saves.turnToReplace(id, messageId).state);
  const { input, narration, check, state, messages, sceneImage, journalEdits } = saves.turnToReplace(id, messageId);
  // The old picture goes with its response, so the new one always gets its own, whatever the Narrator decides.
  const hadPicture = !!sceneImage || images.sceneDrawing(id, messageId);
  const { prompt, memory, playMode } = turnPrompt(saves, settings, id, signal, textProvider, {
    state,
    messages,
    input,
    // The response being replaced keeps its own, which a Regenerate carries over.
    directions: saves.directions(id, messageId),
    journalEdits,
    picture: images.ready(),
  });
  const kind = feedback === undefined ? "regenerate" : "rewrite";
  const replaced = await narrate(textProvider, signal, emit, {
    kind,
    prompt: [...prompt, ...replacementInstruction(feedback === undefined ? undefined : { narration, feedback }, hadPicture && images.ready())],
    input: feedback ?? "",
    refusal: "The Narrator refused this, so the response stays as it was.",
    pcName: saves.read(id).pc.name,
    pcTraits: saves.read(id).pc.physicalTraits ?? "",
    before: state,
    upkeep: reviewProvider && { provider: reviewProvider, settings, input },
    consistency,
    previous: lastNarration(messages),
    seen: () => [saves.read(id).startingHook ?? "", ...messages.map(({ text }) => text)].join("\n"),
    check,
    memory,
    playMode,
    commit: (text, _check, advance, choices) => saves.replaceTurn(id, messageId, text, advance, feedback?.trim() || undefined, choices),
    committed: (replacement, scene) => {
      images.forget(id, messageId - 1, kind);
      // shortcut: a Narrator that writes no prompt gets the old one, which shows the old moment and draws with no portraits. Retry the reply if real models do this.
      const description = scene.description || (sceneImage?.prompt ?? "");
      if (hadPicture) log.info("turn", "Replaced Turn's Scene Image forced", { message: replacement });
      if (hadPicture && !scene.description && sceneImage) log.warning("turn", "Replacement drawn from the old image's prompt", { message: replacement });
      images.sceneChanged(id, replacement, hadPicture ? { ...scene, changed: true, description } : scene);
    },
    times,
  });
  followedUp(id, kind, images, times);
  return replaced;
}

/** An Edit: the player's words replace the latest response's, and the Narrator brings the state in line with them. The picture and any Check stay. */
export async function editResponse(
  saves: SaveStore,
  { textProvider, settings, images, reviewProvider }: WorldContext,
  id: string,
  messageId: number,
  text: string,
  signal: AbortSignal,
  emit: TurnEvents = () => {},
) {
  const times = { started: Date.now() };
  await settleJournal(saves, { textProvider, settings, images, reviewProvider }, id, signal, () => saves.turnToReplace(id, messageId).state);
  const { input, state, messages, journalEdits } = saves.turnToReplace(id, messageId);
  // An Edit that keeps the response whole keeps the Loose Ends it resolved, as the Narrator, bringing the state in line
  // again, left one open to the end of a play.
  const replaced = saves.messages(id).find((message) => message.id === messageId)?.text ?? "";
  const after = saves.latestState(id).looseEnds;
  const resolved = replaced && text.includes(replaced) ? state.looseEnds.filter((end) => !after.includes(end)) : [];
  const { prompt, memory, playMode } = turnPrompt(saves, settings, id, signal, textProvider, {
    state,
    messages,
    input,
    journalEdits,
    // No picture is drawn, so the Narrator needn't write a prompt for one.
    picture: false,
  });
  const done = await narrate(textProvider, signal, emit, {
    kind: "edit",
    prompt: [...prompt, editInstruction(text)],
    input: text,
    refusal: "The Narrator refused this edit, so the response stays as it was.",
    pcName: saves.read(id).pc.name,
    pcTraits: saves.read(id).pc.physicalTraits ?? "",
    before: state,
    upkeep: reviewProvider && { provider: reviewProvider, settings, input },
    previous: lastNarration(messages),
    seen: () => [saves.read(id).startingHook ?? "", ...messages.map(({ text }) => text)].join("\n"),
    narration: text,
    memory,
    playMode,
    commit: (narration, _check, advance, choices) =>
      saves.editTurn(
        id,
        messageId,
        narration,
        (before) => {
          const next = advance(before);
          const kept = next.looseEnds.filter((end) => resolved.includes(end));
          if (kept.length > 0) log.info("turn", "Loose Ends kept resolved by an Edit", { looseEndsKept: kept.length });
          return { ...next, looseEnds: next.looseEnds.filter((end) => !kept.includes(end)) };
        },
        choices,
      ),
    // Only portraits for anyone new, as the Scene Image stays.
    committed: (edited, scene) => images.sceneChanged(id, edited, { ...scene, changed: false }),
    times,
  });
  followedUp(id, "edit", images, times);
  return done;
}

async function narrate(
  textProvider: TextProvider,
  signal: AbortSignal,
  emit: TurnEvents,
  {
    kind,
    prompt,
    input,
    refusal,
    pcName,
    pcTraits,
    before,
    upkeep,
    consistency,
    previous = "",
    seen,
    mustMeet = [],
    narration: edited,
    check: storedCheck,
    memory: pendingMemory,
    rollCheck,
    playMode,
    commit,
    committed,
    counted,
    askClose,
    times,
  }: Narrated,
) {
  const schemas = {
    any: threadsHeld(SCHEMAS[playMode].any, before.plotThreads.slice(0, MAX_PLOT_THREADS)),
    noCheck: threadsHeld(SCHEMAS[playMode].noCheck, before.plotThreads.slice(0, MAX_PLOT_THREADS)),
  };
  // Kept across attempts, so an invalid reply can never change the outcome.
  let check = storedCheck;
  let narrationSent = 0;
  let retry = "";
  let unplacedBefore = false;
  // Why the last reply failed, told to the Narrator, as a retry with the same prompt mostly repeated the fault.
  let why: Prompt = [];
  // The PC's lines refused so far, as a retry gave one to someone else nearly word for word.
  const refusedLines: string[] = [];
  for (let attempt = 1; ; attempt++) {
    // Without a reason the player sees text vanish, which looks like a glitch.
    if (narrationSent > 0) emit("restart", { reason: retry });
    narrationSent = 0;
    let generation: string | undefined;
    let id: string | undefined;
    let partial = "";
    const runaway = new AbortController();
    // A model asked to hold its narration for the roll mostly writes it anyway, which is thrown away, so the reply stops at the rating.
    const early = new AbortController();
    let rated: z.infer<typeof CheckRequest> | undefined;
    // Worked out once the reply's check is complete, and never looked at again: only a None or null check lets narration stream.
    let opened: unknown;
    let none = false;
    const onText = (text: string) => {
      partial += text;
      const visible = withoutThinking(partial);
      if (visible.length > RUNAWAY_CHARS * (kind === "opening" ? 2 : 1)) runaway.abort(RAN_ON);
      if (opened === undefined) {
        opened = openingCheck(visible);
        none = opened !== undefined && isNone(opened);
        if (opened !== undefined && !none && !check && rollCheck) {
          // shortcut: OpenRouter's record gives a stopped call's usage; other providers' stopped rating calls go uncounted in Usage, add a lookup if one offers it.
          rated = CheckRequest.safeParse(opened).data;
          if (rated) early.abort(new StoppedOnPurpose(RATED));
        }
      }
      if (edited !== undefined || !none) return;
      const narration = narrationSoFar(visible);
      if (narration.length <= narrationSent) return;
      emit("narration", { text: narration.slice(narrationSent) });
      narrationSent = narration.length;
    };
    try {
      const reply: string = await askNarrator(
        textProvider,
        [...prompt, ...(check ? [resultInstruction(check)] : []), ...(unplacedBefore ? [SET_SCENE_NOTE] : []), ...why],
        {
          schema: check || !rollCheck ? schemas.noCheck : schemas.any,
          call: kind,
          onText,
          onGeneration: (each) => (generation = each),
          onCall: (each) => (id = each),
          signal: AbortSignal.any([signal, runaway.signal, early.signal]),
        },
        input,
        refusal,
        runaway.signal,
      ).catch((cause: unknown): string => {
        if (rated && !signal.aborted) return JSON.stringify({ check: rated });
        const closed = runaway.signal.aborted && !signal.aborted ? closedAtLastOperation(withoutThinking(partial)) : undefined;
        if (!closed) throw cause;
        log.warning("turn", "Run-on reply kept", { attempt, generation, sent: withoutThinking(partial).length, kept: closed.length });
        return closed;
      });
      const streamed = Date.now();
      const response = parseReply<z.infer<typeof NarratorResponse | typeof EditedTurn>>(reply, edited === undefined ? NarratorResponse : EditedTurn);
      if (response.check) {
        if (check || !rollCheck) throw new InvalidResponse();
        check = rollCheck(response.check);
        attempt = 0; // The result call gets its own retries.
        why = [];
        continue;
      }
      const { people, summary, recent_summary, scene_changed, visual_description, chapter_ends } = response;
      // Kept without the loop, not written again, as DeepSeek's whole narration was lost to a retry eight times in one 30-round play.
      const operationLimit = MAX_OPERATIONS * (kind === "opening" ? 2 : 1);
      let state_operations = withoutLoop(response.state_operations, operationLimit);
      const looping = state_operations.length < response.state_operations.length;
      // The opening starts from a world just written, which one opening's removes wiped before the story had used any of it. Never
      // the Lore Entry of someone in the story, as it holds who they are and how they look, and a lone remove lost one mid-story.
      const person = (title: string) =>
        before.worldBible.some(
          (entry) => entry.title === title && before.npcs.some(({ name }) => [entry.title, ...entry.keywords].some((word) => nameForms(name).includes(word))),
        );
      const kept = state_operations.filter((operation) => operation.op !== "remove_lore_entry" || (kind !== "opening" && !person(operation.title)));
      if (kept.length < state_operations.length)
        log.info("turn", "Operations dropped", {
          attempt,
          generation,
          [kind === "opening" ? "openingLoreRemoves" : "personLoreRemoves"]: state_operations.length - kept.length,
        });
      state_operations = kept;
      // Only asked of World Moves On, which weighs it at its next move, as lone resolves ended threads whose secrets were unplayed.
      const asks = state_operations.flatMap((operation) => (operation.op === "resolve_plot_thread" ? [operation.thread] : []));
      state_operations = state_operations.filter(({ op }) => op !== "resolve_plot_thread");
      let asked: string[] = [];
      let rewrites: (readonly [string, string])[] = [];
      // Later replies copy marks like these, so they never reach a Save.
      const unlabelled = withoutFields(withoutStrayMarks(response.narration as string));
      const speakers = [
        ...before.npcs.map(({ name }) => name),
        ...state_operations.flatMap((operation) => (operation.op === "add_npc" ? [operation.name] : [])),
      ];
      const cleaned = withKnownSpeakers(unlabelled, [...new Set(speakers)]);
      if (cleaned !== unlabelled && edited === undefined) log.info("turn", "Speaker labels given in full", { attempt, generation });
      let narration = edited ?? withoutBareSpeech(cleaned, pcName);
      if (narration !== cleaned && edited === undefined)
        log.info("turn", "Bare speech dropped", { attempt, generation, lines: lineCount(cleaned) - lineCount(narration) });
      // The last attempt keeps such a reply, as losing the Turn costs more than a long speech.
      // A picture without set_scene would be drawn from the last scene's place and people, which may have moved on. State Upkeep
      // brings the scene up to date, so with it the picture is kept; without it the reply is written again, then the picture dropped.
      // Never kept, even on the last attempt, as what isn't a story is no Turn.
      if (edited === undefined && check && declined(narration)) throw new InvalidResponse(undefined, { cause: DECLINED });
      if (edited === undefined && !hasWords(narration)) throw new InvalidResponse(undefined, { cause: NO_WORDS });
      if (edited === undefined && isFragment(narration)) throw new InvalidResponse(undefined, { cause: FRAGMENT });
      if (edited === undefined && isJsonObject(narration)) throw new InvalidResponse(undefined, { cause: JSON_NARRATION });
      // Never kept either, as the Turn then never happens, nor the Check's result it was asked to tell.
      if (edited === undefined && previous && copiesPrevious(narration, previous)) throw new InvalidResponse(undefined, { cause: COPIED });
      const unplaced = scene_changed && !state_operations.some(({ op }) => op === "set_scene") ? "a picture without set_scene" : undefined;
      const relabelled = edited === undefined && copiesRefusedLine(narration, refusedLines);
      if (relabelled) log.info("turn", "Refused line given to another", { attempt, generation });
      const spoken = edited === undefined ? (relabelled ? PC_LINE : spokenLineFault(narration, pcName)) : undefined;
      if (spoken === PC_LINE) refusedLines.push(...spokenLines(narration, (speaker) => isPc(speaker, pcName)));
      // The opening sets the book's voice, which every reply copies, so speech it leaves in the prose is written again there alone:
      // checked on every reply, it doubled a Turn's calls on a model that writes speech in the prose, and the retry didn't change it.
      const inline = edited === undefined && kind === "opening" && speechOutsideLines(narration) ? INLINE_SPEECH : undefined;
      const unmet = edited === undefined && kind === "opening" && peopleLeftOut(narration, mustMeet).length > 0 ? LEFT_OUT : undefined;
      const choices = playMode === "choices" ? usableChoices(response.choices) : undefined;
      // A reply good but for its Choices keeps its story, and the Choices are asked for alone once it's checked.
      const unchosen = playMode === "choices" && !choices;
      // A long speech is only logged, as rewriting it restarted too many Turns the player could see.
      const noted = edited === undefined && isNoteAboutTurn(narration) ? NOTE_ABOUT_TURN : undefined;
      const fault =
        attempt < MAX_ATTEMPTS ? (noted ?? (upkeep ? undefined : unplaced) ?? (spoken === LONG_SPEECH ? undefined : spoken) ?? inline ?? unmet) : undefined;
      unplacedBefore = fault === unplaced && !!unplaced;
      if (fault) throw new InvalidResponse(undefined, { cause: fault });
      if (spoken === LONG_SPEECH) log.warning("turn", "Long speech kept", { attempt, generation });
      if (looping)
        log.warning("turn", "Looping operations dropped", { attempt, generation, sent: response.state_operations.length, kept: state_operations.length });
      // Checked before State Upkeep, so a reply that will be written again costs no call.
      const introducedBefore = introduce(before, people, pcName, state_operations);
      const narrated = applyOperations(introducedBefore.state, introducedBefore.operations);
      const clashesBefore = attempt < MAX_ATTEMPTS ? introducedBefore.refused : [];
      if (clashesBefore.length > 0 || narrated.refused.length > 0) throw new InvalidResponse(undefined, { cause: [...clashesBefore, ...narrated.refused] });
      // Both together, as a reply that did so had started the story over, while either alone was a sound reply's slip.
      const restarted = narrated.repeats > 0 && narrated.ignored.some(({ reason }) => reason === "earlier than now");
      if (restarted && attempt < MAX_ATTEMPTS) throw new InvalidResponse(undefined, { cause: RESTARTED });
      let description = withoutJsonTail(visual_description ?? "");
      // The long words a consistency fix took out of the reply.
      let cut: string[] = [];
      let checked: Checked | undefined;
      if (consistency?.enabled()) {
        const told = narration;
        const reply = replyToCheck(before, {
          previous,
          // A Continue in plain words, not its marker.
          input: plainMessage({ role: "player", text: upkeep?.input ?? input }).text,
          timeAfter: narrated.next.storyTime,
          pc: pcName,
          pcTraits,
          narration,
          visualDescription: description,
          check,
        });
        const result = await checkConsistency(
          consistency,
          reply,
          (text) => usableFix(withoutStrayMarks(text), pcName, told, check) && !repeatsPrevious(text, told, previous),
          signal,
        );
        checked = result.checked;
        narration = withoutBareSpeech(withoutStrayMarks(result.narration), pcName);
        description = result.visualDescription;
        // Nothing tells the player, but the fixed reply takes the streamed one's place.
        if (narration !== told) {
          emit("revise", { text: narration });
          // How long the player read the streamed reply before it changed, which is what the check costs them.
          log.info("turn", "Reply revised", { attempt, generation, ms: Date.now() - streamed });
        }
        cut = cutWords(told, narration);
        const kept = withoutCut(state_operations, cut);
        if (kept.length < state_operations.length)
          log.info("turn", "What was learned of a fixed slip dropped", { attempt, generation, operations: state_operations.length - kept.length });
        state_operations = kept;
      }
      const story = seen?.() ?? "";
      const threads = turnThreadChanges(state_operations, before, narration);
      if (Object.keys(threads.dropped).length > 0) log.info("turn", "Thread changes dropped", { attempt, generation, ...threads.dropped });
      state_operations = threads.kept;
      const amended = state_operations.filter((operation) => operation.op === "update_plot_thread" && operation.truth).length;
      if (amended > 0) log.info("turn", "Thread truths amended", { attempt, generation, amended });
      if (seen) {
        const read = withoutUnread(state_operations, narrated.next, `${story}\n${narration}`);
        if (read.length < state_operations.length)
          log.info("turn", "Journal entries naming secrets dropped", { attempt, generation, operations: state_operations.length - read.length });
        state_operations = read;
      }
      // The text is final here, so the player reads it while the follow-ups below run, and nothing after changes it.
      emit("reply", { text: narration });
      const shown = Date.now();
      log.info("turn", "Reply shown", { kind, attempts: attempt, ms: shown - times.started });
      // A Stop once the reply is shown skips only the follow-ups left, as the player has read it.
      const followUp = <T>(name: "upkeep" | "choices", work: Promise<T> | T): Promise<T | undefined> =>
        Promise.resolve(work)
          .catch((error: unknown) => {
            if (!signal.aborted) throw error;
            log.info("turn", "Follow-up stopped, reply kept", { followUp: name });
            return undefined;
          })
          .finally(() => {
            times[name] = Date.now() - shown;
          });
      const timed = state_operations.some(({ op }) => op === "set_story_time");
      const alone = () =>
        writeChoices(textProvider, narration, signal, previous, plainMessage({ role: "player", text: upkeep?.input ?? input }).text, {
          facts: narrated.next.pcKnown.facts,
          looseEnds: narrated.next.looseEnds,
        }).then((written) =>
          // Held to what the PC knows, as the Choices the reply came with are.
          written && upkeep && seen !== undefined ? knownChoices(written, narrated.next, seen(), narration, upkeep.settings.read().storyInLog) : written,
        );
      // Merged with what each ask kept, up to two asks, as taking one set or the other offered two Choices when each had lost one to a leak.
      const refilled = async (kept: string[]) => {
        for (let ask = 0; ask < 2 && kept.length < 3; ask++) {
          const written = await alone();
          if (!written) break;
          const fresh = written.filter((choice) => !kept.some((other) => sameApproach(choice, other)));
          if (fresh.length < written.length) log.info("turn", "Choices repeating a kept one dropped", { count: written.length - fresh.length });
          kept = [...new Set([...kept, ...fresh])].slice(0, 3);
        }
        return kept;
      };
      // Side by side, as neither needs the other, so a slow reviewer holds the Choices back once, not twice.
      const [upkept, offered] = await Promise.all([
        // Held to the fix's cut as the Narrator's are, as Upkeep's npc_learns can carry what the fix took out.
        followUp(
          "upkeep",
          upkeep
            ? upkeepOperations(upkeep, pcName, narrated.next, check, previous, narration, signal, timed).then((ops) => ops && withoutCut(ops, cut))
            : undefined,
        ),
        followUp(
          "choices",
          choices && upkeep && seen !== undefined
            ? (() => {
                const kept = knownChoices(choices, narrated.next, seen(), narration, upkeep.settings.read().storyInLog);
                // Asked for alone, as a lone Choice left after dropping leaks lost a play its clue, and two were left in four rounds.
                if (kept.length >= 3) return kept;
                log.info("turn", "Too few Choices kept", { attempt, generation, kept: kept.length });
                return refilled(kept);
              })()
            : unchosen
              ? refilled([])
              : choices,
        ),
      ]);
      const dropped = !!unplaced && !upkept;
      if (dropped) log.warning("turn", "Picture dropped without set_scene", { attempt, generation });
      let upkeepRefused = 0;
      const memory = await pendingMemory;
      let moved = false;
      let location = "";
      let npcs: Scene["npcs"] = [];
      let wearing: Scene["wearing"] = [];
      let portraits: Scene["portraits"] = [];
      let restyled: Scene["restyled"] = [];
      let repeated = 0;
      let ignored: Refusal[] = [];
      const messages = commit(
        narration,
        check,
        (state) => {
          const introduced = introduce(state, people, pcName, state_operations);
          const { next: told, refused, ignored: harmless, repeats } = applyOperations(introduced.state, introduced.operations);
          // Dropping one would leave narration that disagrees with the state, so the whole Turn is invalid.
          // A shared name is kept on the last attempt, as losing the Turn costs more.
          const clashes = attempt < MAX_ATTEMPTS ? introduced.refused : [];
          if (clashes.length > 0 || refused.length > 0) throw new InvalidResponse(undefined, { cause: [...clashes, ...refused] });
          // After the Narrator's own, which it corrects. One the state code refuses is only dropped, as the reply already stands.
          const kept = applyOperations(told, upkept ?? []);
          upkeepRefused = kept.refused.length + kept.ignored.length;
          const next = kept.next;
          // Through this Turn's amended truths, so an ask follows its thread to its new words, as the next move matches them exactly.
          rewrites = [...state_operations, ...(upkept ?? [])].flatMap((operation) =>
            operation.op === "update_plot_thread" && operation.truth
              ? [[closestThread(state.plotThreads, operation.thread) ?? operation.thread, operation.truth] as const]
              : [],
          );
          const rewritten = new Map(rewrites);
          asked = asks.flatMap((thread) => {
            const old = closestThread(state.plotThreads, thread) ?? thread;
            return closestThread(next.plotThreads, rewritten.get(old) ?? old) ?? [];
          });
          repeated = repeats;
          ignored = harmless;
          // Kept when cut below two-fifths of the last, as replies that started the story again cut it to 36-39% (bench logs),
          // while sound ones, shortening one past its 500 words, kept half.
          const words = { was: countWords(next.summary), now: countWords(summary) };
          if (words.now * 5 < words.was * 2) log.warning("turn", "Summary kept", words);
          // Written before the fix, so it may tell what the fix took out.
          else if (cut.some((word) => wholeWord(word, "iu").test(summary))) log.info("turn", "Summary kept after a fix", words);
          else if (summary.trim()) next.summary = summary.trim();
          if (recent_summary?.trim()) next.recentSummary = recent_summary.trim();
          if (memory) next.sceneMemories.push(memory);
          next.chapterReady = !!chapter_ends;
          moved = movedScene(state, next);
          location = next.scene.location;
          npcs = next.npcs;
          wearing = next.inventory.wearing;
          portraits = portraitsDue(state, next);
          restyled = restyledBy(state, next);
          return next;
        },
        forThePc(offered, pcName),
      );
      // The Turn is saved by now, so image trouble must not report it failed, or the player would send it again.
      try {
        committed(messages.at(-1)!.id, {
          changed: moved || (!!scene_changed && !dropped),
          moved,
          description: dropped ? "" : description,
          location,
          npcs,
          wearing,
          portraits,
          restyled,
          // By the name the person had, as a merge may name them by part of it.
          merged: [...state_operations, ...(upkept ?? [])].flatMap((operation) =>
            operation.op === "merge_npc"
              ? [[findPerson(introducedBefore.state.npcs, operation.name)?.name ?? operation.name, operation.into] as [string, string]]
              : [],
          ),
        });
      } catch (error) {
        log.error("turn", "Image work after commit failed", errorFields(error));
      }
      if (repeated > 0) log.info("turn", "Repeats ignored", { count: repeated });
      if (ignored.length > 0) log.warning("turn", "Operations ignored", { reason: refusalText(ignored) });
      askClose?.(asked, rewrites);
      const operations = state_operations.map(({ op }) => op);
      counted?.({ difficulty: check?.difficulty, operations });
      // Counts only, so that the log never repeats the story: a Check's action is the player's words, so it's left out.
      log.info("turn", "Turn committed", () => ({
        kind,
        message: messages.at(-1)!.id,
        attempts: attempt,
        check: check ? { difficulty: check.difficulty, roll: check.roll, outcome: check.outcome, degree: check.degree } : false,
        narration: narration.length,
        summary: summary.trim().length,
        ...(memory && { memoryFirst: memory.firstMessage, memoryLast: memory.lastMessage, memoryLength: memory.text.length }),
        people: people.length,
        operations,
        ...(upkeep && { upkeep: (upkept ?? []).map(({ op }) => op), upkeepRefused }),
        ...(checked && { consistency: checked }),
        sceneChanged: !!scene_changed,
        chapterEnds: !!chapter_ends,
        // The asks that matched an open thread, as the Narrator's own count logged asks of threads that never existed.
        ...(asks.length > 0 && { closeAsked: asked.length }),
      }));
      return messages;
    } catch (cause) {
      retry = `${retryIfInvalid(cause, attempt, input, { id, generation })}, so the Narrator is writing it again (try ${attempt + 1} of ${MAX_ATTEMPTS}).`;
      const reason = whyInvalid(cause as InvalidResponse);
      why = reason === OVERTHOUGHT ? [] : [couldNotUse(reason)];
    }
  }
}

const choiceWords = (text: string) => new Set(text.toLowerCase().match(/\p{L}[\p{L}']{3,}/gu) ?? []);
/**
 * Whether two Choices take one approach in other words: four words of four letters or more shared, half the shorter's, as a
 * Choice asked for alone offered "pull back the sheet and examine" beside a kept "turn back the sheet and examine".
 */
const sameApproach = (one: string, other: string) => {
  const [a, b] = [choiceWords(one), choiceWords(other)];
  const shared = [...a].filter((word) => b.has(word)).length;
  return one === other || (shared >= 4 && shared * 2 >= Math.min(a.size, b.size));
};
const longWords = (text: string) => new Set(text.toLowerCase().match(/\p{L}{6,}/gu) ?? []);
/** The long words a fix took out of the reply, which what the PC learns in that Turn mustn't keep. */
export const cutWords = (told: string, fixed: string) => {
  const kept = longWords(fixed);
  return [...longWords(told)].filter((word) => !kept.has(word));
};
// What the PC or someone else learns from the reply, which the Narrator wrote before the fix.
const LEARNED: StateOperation["op"][] = ["add_known_fact", "npc_learns", "add_loose_end", "set_known_npc_summary"];
/**
 * The operations without what the PC or an NPC learns that names a word a fix took out, as a fix cut an admission from the reply
 * and the known facts kept it, and later Choices were built on it.
 */
export const withoutCut = <Operation extends StateOperation>(operations: Operation[], cut: string[]) =>
  operations.filter(
    (operation) =>
      !LEARNED.includes(operation.op) ||
      !cut.some((word) =>
        wholeWord(word, "iu").test(
          Object.values(operation)
            .filter((value) => typeof value === "string")
            .join(" "),
        ),
      ),
  );
/** Whether a fix put in a sentence of eight words or more copied from the previous reply, as one swapped an earned admission for a speech already made. */
export const repeatsPrevious = (fixed: string, told: string, previous: string) =>
  fixed.split(/(?<=[.!?…]["”]?)\s+/).some((sentence) => countWords(sentence) >= 8 && !told.includes(sentence) && previous.includes(sentence));

/** Whether four in five of a reply's words are in sentences of eight words or more from the previous reply, as one came back as the last reply whole after ": ". */
const copiesPrevious = (text: string, previous: string) =>
  countWords(
    text
      .split(/(?<=[.!?…]["”]?)\s+/)
      .map((sentence) => sentence.replace(/^[\s:;,-]+/, ""))
      .filter((sentence) => countWords(sentence) >= 8 && previous.includes(sentence))
      .join(" "),
  ) *
    5 >=
  countWords(text) * 4;
const COPIED = "the previous reply written again";
const RESTARTED = "the story started over, its clock set back and what the PC knew added again";

/** Whether a fix passes what a Narrator reply must. It may run a little longer than the reply it fixes. */
export function usableFix(text: string, pcName: string, told: string, check?: Check) {
  return (
    hasWords(text) &&
    !isJsonObject(text) &&
    !FIELD_LINE.test(text) &&
    !(check && declined(text)) &&
    ![PC_LINE, TAG_WITHOUT_BRACKET].includes(spokenLineFault(text, pcName) ?? "") &&
    // A fix changes the fewest words, and one that cut a passage to a third erased the clue a high roll had found.
    countWords(text) * 5 >= countWords(told) * 4 &&
    withinLimit(text, Math.max(REPLY_WORDS, countWords(told)))
  );
}

/** Why the spoken lines break the reply's shape, if they do: a tag missing its "[", a line for the PC, or someone speaking more than three times. */
export function spokenLineFault(narration: string, pcName: string) {
  const lines = new Map<string, number>();
  for (const line of narration.split("\n").map((text) => text.trim())) {
    if (/^[^[\]\s][^[\]]*\]:/.test(line)) return TAG_WITHOUT_BRACKET;
    const speaker = line.match(/^\[([^[\]]+)\]:/)?.[1]?.trim();
    // The player alone writes what the PC says, and the prompt saying so was ignored.
    if (speaker && isPc(speaker, pcName)) return PC_LINE;
    if (speaker) lines.set(speaker, (lines.get(speaker) ?? 0) + 1);
  }
  return [...lines.values()].some((count) => count > 3) ? LONG_SPEECH : undefined;
}
const isPc = (speaker: string, pcName: string) =>
  !!pcName && (speaker.toLowerCase() === pcName.toLowerCase() || (givenName(speaker) ?? "") === givenName(pcName));

/**
 * Each speaker label of two words or more that shortens one known name, word by word or to an initial, written as that name,
 * as "[Reverend Amos T.]" was kept for Reverend Amos Thorne. A lone word is left, as a first name alone is a fair label.
 */
export const withKnownSpeakers = (narration: string, names: string[]) =>
  narration.replace(/^([ \t]*)\[([^[\]\n]+)\]:/gm, (line, indent: string, label: string) => {
    const words = label.trim().split(/\s+/);
    const shortens = (name: string) => {
      const full = name.split(/\s+/);
      return (
        name !== label.trim() &&
        words.length >= 2 &&
        words.length <= full.length &&
        words.every((word, index) => {
          const bare = word.replace(/\.$/, "").toLowerCase();
          const whole = full[index]!.toLowerCase();
          return bare === whole || (bare.length === 1 && whole.startsWith(bare));
        })
      );
    };
    const matches = names.filter(shortens);
    return matches.length === 1 ? `${indent}[${matches[0]}]:` : line;
  });

/** The words of each [Name]: line whose speaker `whose` picks, in lower case. */
const spokenLines = (narration: string, whose: (speaker: string) => boolean) =>
  narration.split("\n").flatMap((line) => {
    const [, speaker = "", said = ""] = line.trim().match(/^\[([^[\]]+)\]:(.*)$/) ?? [];
    return speaker && whose(speaker.trim())
      ? [
          said
            .toLowerCase()
            .match(/\p{L}+(?:['’]\p{L}+)*/gu)
            ?.join(" ") ?? "",
        ]
      : [];
  });
/** Whether any spoken line holds four in five of the words of a line refused as the PC's, whoever it is now given to. */
const copiesRefusedLine = (narration: string, refused: string[]) =>
  refused.length > 0 &&
  spokenLines(narration, () => true).some((line) => {
    const words = new Set(line.split(" "));
    return refused.some((old) => {
      const oldWords = old.split(" ").filter(Boolean);
      return oldWords.length >= 4 && oldWords.filter((word) => words.has(word)).length * 5 >= oldWords.length * 4;
    });
  });
const LONG_SPEECH = "someone speaks more than three times";
const INLINE_SPEECH = "speech in the prose, not on a speaker line";
const LEFT_OUT = "an opening that leaves out someone its Starting Hook names";

/** Who of `people` the narration never names, by their full name or any capitalised part of it, such as a surname. */
export const peopleLeftOut = (narration: string, people: string[]) =>
  people.filter((name) => !nameForms(name).some((part) => wholeWord(part, "u").test(narration)));

/** Whether a line of prose, not a [Name]: line, holds quoted speech, as in 'Come here,' she said. An apostrophe isn't a quote. */
export const speechOutsideLines = (narration: string) =>
  narration
    .split("\n")
    .map((line) => line.trim())
    // Speech ends on its own punctuation inside the quote, which a sign or a title, such as "THE RED LION". doesn't.
    .some((line) => !line.startsWith("[") && /(^|[\s(—-])(“[^”]{2,}[.,!?…—-]”|"[^"]{2,}[.,!?…—-]"|['‘]\p{Lu}[^'‘’]*[.,!?…—-]['’](?!\p{L}))/u.test(line));
/**
 * The narration without the PC's lines that are only quoted speech, which GLM wrote in half the Turns of an 80-round play despite
 * the rule, adding arguments the player never gave. Only after a paragraph whose last sentence opens on the PC, as 7 of 8 such
 * lines dropped by any paragraph were an NPC's, clues among them.
 * shortcut: a note or letter quoted whole after the PC's paragraph goes too; tell it apart if one is seen.
 */
export const withoutBareSpeech = (narration: string, pc: string) => {
  const pcs = new RegExp(`^(${[...nameForms(pc), "you"].map(RegExp.escape).join("|")})(?![\\p{L}\\p{N}])`, "iu");
  return narration
    .replace(/(^|\n)[ \t]*(“[^”\n]*[.,!?…—-]”|"[^"\n]*[.,!?…—-]")[ \t]*(?=\n|$)\n*/g, (line, start: string, _speech, at: number) => {
      const before = narration.slice(0, at).trimEnd();
      const last =
        before
          .slice(before.lastIndexOf("\n") + 1)
          .split(/(?<=[.!?…])\s+/)
          .at(-1) ?? "";
      return pcs.test(last) ? start : line;
    })
    .trimEnd();
};
const lineCount = (text: string) => text.split("\n").filter((line) => line.trim()).length;
const TAG_WITHOUT_BRACKET = "a speaker tag without its [";
const PC_LINE = "a spoken line for the PC";

type Refusal = { op: string; reason: string };
const refusalText = (refusals: Refusal[]) => refusals.map(({ op, reason }) => `${op}: ${reason}`).join(", ");

/** What was wrong with a reply, without any of its text. */
function whyInvalid({ cause }: InvalidResponse) {
  if (typeof cause === "string") return cause;
  // A custom check's message is the app's own fixed words, never the reply's, so it may name what failed.
  // No path for a fault of the whole reply, as its empty one printed ": : ".
  if (cause instanceof z.ZodError)
    return cause.issues.map(({ path, code, message }) => `${path.length > 0 ? `${path.join(".")}: ` : ""}${code === "custom" ? message : code}`).join(", ");
  if (Array.isArray(cause)) return `refused operations: ${refusalText(cause)}`;
  // Not the parser's message, which quotes the reply.
  return cause instanceof SyntaxError ? "not JSON" : "a Check request where none is allowed";
}

/** What a check says to the model alone, in its issue's `params.told`, as it may quote the story, which the log must not hold. */
const toldModel = (cause: unknown): string[] =>
  cause instanceof InvalidResponse && cause.cause instanceof z.ZodError
    ? cause.cause.issues.flatMap((issue) => (issue.code === "custom" && typeof issue.params?.told === "string" ? [issue.params.told] : []))
    : [];

/** What a player is told of an invalid reply, never quoting it, as a reply may hold secrets. */
function playerReason({ cause }: InvalidResponse) {
  if (cause === TAG_WITHOUT_BRACKET) return "A spoken line in the last reply was missing its speaker";
  if (cause === PC_LINE) return "The last reply spoke for your character";
  if (cause === INLINE_SPEECH) return "The story's opening didn't set out who says what";
  if (cause === LEFT_OUT) return "The story's opening left out someone it was set up to meet";
  if (cause === "a picture without set_scene") return "The last reply moved to a new scene without saying where";
  if (cause === DECLINED) return "The last reply wasn't a story, which can mean the AI's content rules block this";
  if (cause === NOTE_ABOUT_TURN) return "The last reply was a note about the story instead of the story";
  if (cause === RAN_ON) return "The last reply ran on far too long";
  if (cause === OVERTHOUGHT || cause === OVER_BUDGET) return "The AI thought for too long before writing";
  if (Array.isArray(cause)) return "The last reply changed the story in a way that doesn't fit what's already true";
  if (cause === undefined) return "The last reply asked for a second dice roll";
  return "The last reply came back garbled";
}

/**
 * After the prompt, so the provider's cache still holds, and in the app's own words, never the reply's. It names the reply just
 * written, as "your last reply" led a Narrator to rewrite the story's last Message in place of answering the player's move.
 */
const couldNotUse = (reason: string): Prompt[number] => ({
  role: "system",
  content: `The reply you just wrote to this couldn't be used: ${reason}. Write that reply again, fixing that.`,
});

/** The ids a failed call's log lines carry: the app's own, and the provider's when it sent one. */
type CallIds = { id?: string; generation?: string };

/** Returns, if another attempt should run, why it's needed in the player's words. Anything but an invalid reply goes on up. */
function retryIfInvalid(cause: unknown, attempt: number, input: string, { id, generation }: CallIds, by = "Narrator") {
  if (!(cause instanceof InvalidResponse)) throw cause;
  const reason = whyInvalid(cause);
  log.warning("turn", `Unusable ${by} reply`, { attempt, of: MAX_ATTEMPTS, reason, id, generation });
  if (attempt === MAX_ATTEMPTS) {
    // Told plainly as a block, with the move kept to change, as a provider's own refusal is.
    if (reason === DECLINED) throw new TurnFailed(DECLINED_MESSAGE, "refused", input, { cause: new Error(reason) });
    throw new TurnFailed("The Narrator gave no usable response", "retryable", input, { cause: new Error(reason) });
  }
  return playerReason(cause);
}

async function askNarrator(
  textProvider: TextProvider,
  prompt: Prompt,
  request: Parameters<TextProvider>[1],
  input: string,
  refusal: string,
  runaway?: AbortSignal,
) {
  try {
    return await textProvider(prompt, request);
  } catch (cause) {
    // In a Turn, a runaway is a model stuck in a loop, which a fresh try mostly isn't, so it gets the retries a garbled reply does.
    // Any other call that reaches the token limit would likely reach it again, so it fails at once and says why.
    // The reason is the cause, as whyInvalid and playerReason read it: given the error, a runaway was logged as a Check request.
    if (cause instanceof ThoughtTooLong) throw new InvalidResponse(undefined, { cause: OVERTHOUGHT });
    if (cause instanceof ThinkingBudgetReached) throw new InvalidResponse(undefined, { cause: OVER_BUDGET });
    if (runaway && (runaway.aborted || cause instanceof ReplyCutOff)) throw new InvalidResponse(undefined, { cause: RAN_ON });
    if (cause instanceof ContentRefused) {
      throw new TurnFailed(refusal, "refused", input, { cause });
    }
    // A stream line that isn't JSON is a garbled reply, so it gets the same retries as one.
    if (cause instanceof SyntaxError) throw new InvalidResponse(undefined, { cause });
    const message = cause instanceof TextProviderFailed ? cause.message : "The Text Provider request failed";
    throw new TurnFailed(message, "retryable", input, { cause });
  }
}

/** One reply matching `schema`, with the retries and failures of a Turn. Nothing streams, as a reply may hold secrets. */
const SceneMemoryReply = z.object({ scene_memory: z.string().refine((text) => text.trim() !== "") });

/** Throws as askForJson does. */
export async function askForMemory(textProvider: TextProvider, batch: Message[], previous: string | undefined, signal: AbortSignal) {
  const { scene_memory } = await askForJson(textProvider, memoryPrompt(batch, previous), SceneMemoryReply, "The model refused a batch of Messages.", signal, {
    call: "memory",
  });
  return scene_memory.trim();
}

const ChapterTitleReply = z.object({ title: z.string().trim().min(1).max(80) });

/** Throws as askForJson does. */
export async function askForChapterTitle(textProvider: TextProvider, memories: string[], recent: Message[], signal: AbortSignal) {
  const { title } = await askForJson(textProvider, chapterTitlePrompt(memories, recent), ChapterTitleReply, "The model refused to title the chapter.", signal, {
    call: "chapterTitle",
  });
  return title;
}

/** Runs beside the Turn, so the player waits no longer. A missed memory costs nothing: the window keeps its Messages, and the next Turn asks again. */
async function nextMemory(
  textProvider: TextProvider,
  messages: Message[],
  sceneMemories: SceneMemory[],
  memoryStart: number,
  windowMessages: number,
  signal: AbortSignal,
) {
  const range = memoryDue(messages, sceneMemories, memoryStart, windowMessages);
  if (!range) return null;
  const batch = readable(messages.filter(({ id }) => id >= range.firstMessage && id <= range.lastMessage));
  try {
    return { ...range, text: await askForMemory(textProvider, batch, sceneMemories.at(-1)?.text, signal) };
  } catch (cause) {
    log.warning("turn", "Scene Memory missed", { reason: cause instanceof Error ? cause.message : "unknown" });
    return null;
  }
}

export async function askForJson<T>(
  textProvider: TextProvider,
  prompt: Prompt,
  schema: z.ZodType<T>,
  refusal: string,
  signal: AbortSignal,
  /**
   * `lessThinking` asks for that many levels below the player's Thinking from the first attempt. `reviewer` names the call's
   * model in the log. `hurried: false` fails a reply stopped at its thinking budget rather than ask for it with little thinking.
   * `call` names what the call is for in the log, as each call's token use is counted by it.
   */
  {
    call,
    picture = false,
    lessThinking: fewer = 0,
    thinkingBudget,
    thinkingMs,
    reviewer = false,
    hurried = true,
  }: { call: string; picture?: boolean; lessThinking?: number; thinkingBudget?: number; thinkingMs?: number; reviewer?: boolean; hurried?: boolean },
) {
  let generation: string | undefined;
  let id: string | undefined;
  let lessThinking = fewer;
  let asked = prompt;
  for (let attempt = 1; ; attempt++) {
    const request = {
      schema: jsonSchemaOf(schema),
      call,
      picture,
      lessThinking,
      thinkingBudget,
      thinkingMs,
      onText: () => {},
      onGeneration: (each: string) => (generation = each),
      onCall: (each: string) => (id = each),
      signal,
    };
    try {
      return parseReply(await askNarrator(textProvider, asked, request, "", refusal), schema);
    } catch (cause) {
      if (!hurried && cause instanceof InvalidResponse && cause.cause === OVER_BUDGET) throw new ThinkingBudgetReached(OVER_BUDGET);
      retryIfInvalid(cause, attempt, "", { id, generation }, reviewer ? "reviewer" : "Narrator");
      const reason = whyInvalid(cause as InvalidResponse);
      // The same level would most likely think past the limit again.
      if (reason === OVERTHOUGHT) lessThinking++;
      else asked = [...prompt, couldNotUse([reason, ...toldModel(cause)].join("; "))];
    }
  }
}

function parseReply<T>(reply: string, schema: z.ZodType<T>) {
  // shortcut: this takes a code fence or prose around the JSON, but braces in that prose fail validation and retry, parse balanced braces if real models do that.
  const text = withoutThinking(reply);
  try {
    return schema.parse(JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)));
  } catch (cause) {
    throw new InvalidResponse(undefined, { cause });
  }
}
