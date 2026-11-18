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
import { applyOperations, givenName, introduce, Person, type SceneMemory, type State, StateOperation } from "./state-applier";
import { type Checked, type Consistency, checkConsistency, replyToCheck } from "./consistency";
import { countWords, withinLimit } from "./limits";
import { type Upkeep, upkeepOperations } from "./state-upkeep";
import { readable, withoutStrayMarks } from "./web/chat-style";
import { applyWorldChange } from "./world-creation";
import { MOVE_LIMIT, moveDue, moveWorldOn } from "./world-moves-on";

// Each Save's move of the world still running, which the next Turn waits for, so it reads the world as moved.
const moving = new Map<string, Promise<void>>();

/** The token counts and cost a server reports for one reply, in the OpenAI shape. OpenRouter adds `cost`. */
export type TextUsage = { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; cost?: number };

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
    /** An Image Prompt's call, which has its own thinking limit. */
    picture?: boolean;
    /** How many levels below the player's Thinking to ask for, after a reply thought past the limit. */
    lessThinking?: number;
    onText: (text: string) => void;
    onGeneration?: (id: string) => void;
    onUsage?: (usage: TextUsage) => void;
    signal: AbortSignal;
  },
) => Promise<string>;

export type TurnEvents = (event: "narration" | "restart" | "revise", data: object) => void;

export class ContentRefused extends Error {}
/** A failure whose message is fit to show the player. */
export class TextProviderFailed extends Error {}
/** The reply reached the token limit and was cut off. */
export class ReplyCutOff extends TextProviderFailed {}
/** A model stuck thinking, which a fresh try mostly isn't, so every call retries it. */
export class ThoughtTooLong extends ReplyCutOff {
  override name = "ThoughtTooLong";
}
class InvalidResponse extends Error {}

/** An abort reason for a reply stopped on purpose, as it has given all that's needed: logged by its words, and never a failure. */
export class StoppedOnPurpose {
  constructor(readonly why: string) {}
}

const RAN_ON = "ran on far too long";
const OVERTHOUGHT = "thought far too long";
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
const withoutRetired = (operations: unknown) =>
  Array.isArray(operations) ? operations.filter((operation) => !RETIRED.includes((operation as { op?: string })?.op ?? "")) : operations;
const TurnOperation = z.discriminatedUnion(
  "op",
  StateOperation.options.filter(({ shape }) => !RETIRED.includes(shape.op.value)) as unknown as typeof StateOperation.options,
);

const FinishedTurn = z.object({
  // Whether it has words is checked once it's parsed, so a Check's result without any is told as declined.
  narration: z.string().trim().min(1),
  state_operations: z.preprocess(withoutRetired, z.array(TurnOperation).default([])),
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
const ChoicesShape = ResponseShape.extend({
  choices: z
    .array(z.string())
    .describe(
      "exactly three things the PC might say or do next, each one first-person sentence of at most 25 words, built only from what the PC knows, and each taking a clearly different approach, at least one of them moving the story on toward what comes next, such as setting out, acting on a plan or facing what waits. Never hint at risk, difficulty, dice or a Check",
    ),
});
// Once a Check is rolled, or none can be, the schema itself forbids one and asks for the story, as the prompt's "Do not request another check" was ignored three times running.
const SCHEMAS = {
  free: { any: jsonSchemaOf(ResponseShape), noCheck: jsonSchemaOf(ResponseShape.extend({ check: z.null(), narration: z.string() })) },
  choices: { any: jsonSchemaOf(ChoicesShape), noCheck: jsonSchemaOf(ChoicesShape.extend({ check: z.null(), narration: z.string() })) },
};

/** Three different Choices, or none if the reply hasn't that many. */
export function usableChoices(choices: unknown) {
  const parsed = z.array(z.string().trim().min(1)).safeParse(choices);
  const distinct = [...new Set(parsed.data ?? [])];
  return distinct.length >= 3 ? distinct.slice(0, 3) : undefined;
}
const NO_CHOICES = "no usable choices";
// A model that won't write a Check's result can't refuse in words when the provider holds it to the schema, so it sends
// something that isn't a story: replies came back as a lone comma, a single name and the rating written out.
const DECLINED = "a story the AI declined to write";
const RATING_TALK = /\bdifficulty\s*:\s*(?:none|easy|moderate|hard|very hard)\b|\bwhat['’]?s at stake\s*:/i;
const declined = (narration: string) => (narration.match(/\p{L}+/gu)?.length ?? 0) < 2 || RATING_TALK.test(narration);
// Words, not just punctuation, as a reply once came back as a lone comma.
const NO_WORDS = "a story with no words";
const hasWords = (narration: string) => /\p{L}{2}/u.test(narration);
// A result reply once came back as one line about the Turn awaiting its roll, shown as the story.
// Prose speaks of dice and turns too, as at a game, so only a short reply naming two of these, one of them the app's own
// reply, check or result, is taken for such a note.
const NOTE_ABOUT_TURN = "a note about the Turn instead of story";
const isNoteAboutTurn = (narration: string) => {
  const named = new Set(narration.toLowerCase().match(/\b(?:turn|reply|check|dice|roll|rolled|result)\b/g));
  return countWords(narration) < 30 && named.size >= 2 && ["reply", "check", "result"].some((word) => named.has(word));
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

/** What a World Change needs: the Narrator, the reviewer and the pictures a change can restyle. */
type WorldContext = { textProvider: TextProvider; settings: SettingsStore; images: ImagePipeline; reviewProvider?: TextProvider; consistency?: Consistency };

/**
 * Brings the hidden world in line with the player's Journal edits in a call of its own, as a Turn busy writing the
 * story can skip state changes. `stateOf` reads the state the reply starts from, and a stale request throws there,
 * before any call. Any other failure only skips it, as the reply is still told of the edits.
 */
async function settleJournal(saves: SaveStore, context: WorldContext, id: string, signal: AbortSignal, stateOf: () => State) {
  // Stop ends the wait, as a move on a slow model can run two minutes.
  const move = moving.get(id);
  signal.throwIfAborted();
  if (move) await Promise.race([move, new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
  signal.throwIfAborted();
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
    memory,
    // The PC attempts nothing in a Continue, so there is nothing to roll for.
    rollCheck: mayCheck && !isContinueInput(input) ? (request) => resolveCheck(request, dice, nearMissMargin) : undefined,
    playMode,
    commit: (narration, check, advance, choices) => saves.commitTurn(id, basedOn, input, narration, check, advance, choices),
    committed: (messageId, scene) => images.sceneChanged(id, messageId, scene),
    // Only what the player did counts, so not the opening or a Continue, which have nothing to check.
    counted: kind === "turn" && !isContinueInput(input) ? (turn) => usage?.turn(id, model, turn) : undefined,
  });
  const replies = messages.filter(({ role }) => role === "narrator").length + 1;
  if (moveWorld && kind === "turn" && moveDue(state, saves.latestState(id), replies)) {
    // Not awaited, as it runs while the player reads; its own signal, as the Turn's request has ended.
    const move = moveWorldOn(textProvider, settings, saves, id, AbortSignal.timeout(MOVE_LIMIT.ms)).finally(() => moving.delete(id));
    moving.set(id, move);
  }
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
  return narrate(textProvider, signal, emit, {
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
  });
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
  await settleJournal(saves, { textProvider, settings, images, reviewProvider }, id, signal, () => saves.turnToReplace(id, messageId).state);
  const { input, state, messages, journalEdits } = saves.turnToReplace(id, messageId);
  const { prompt, memory, playMode } = turnPrompt(saves, settings, id, signal, textProvider, {
    state,
    messages,
    input,
    journalEdits,
    // No picture is drawn, so the Narrator needn't write a prompt for one.
    picture: false,
  });
  return narrate(textProvider, signal, emit, {
    kind: "edit",
    prompt: [...prompt, editInstruction(text)],
    input: text,
    refusal: "The Narrator refused this edit, so the response stays as it was.",
    pcName: saves.read(id).pc.name,
    pcTraits: saves.read(id).pc.physicalTraits ?? "",
    before: state,
    upkeep: reviewProvider && { provider: reviewProvider, settings, input },
    previous: lastNarration(messages),
    narration: text,
    memory,
    playMode,
    commit: (narration, _check, advance, choices) => saves.editTurn(id, messageId, narration, advance, choices),
    // Only portraits for anyone new, as the Scene Image stays.
    committed: (edited, scene) => images.sceneChanged(id, edited, { ...scene, changed: false }),
  });
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
    narration: edited,
    check: storedCheck,
    memory: pendingMemory,
    rollCheck,
    playMode,
    commit,
    committed,
    counted,
  }: Narrated,
) {
  const schemas = SCHEMAS[playMode];
  // Kept across attempts, so an invalid reply can never change the outcome.
  let check = storedCheck;
  let narrationSent = 0;
  let retry = "";
  let unplacedBefore = false;
  for (let attempt = 1; ; attempt++) {
    // Without a reason the player sees text vanish, which looks like a glitch.
    if (narrationSent > 0) emit("restart", { reason: retry });
    narrationSent = 0;
    let generation: string | undefined;
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
        [...prompt, ...(check ? [resultInstruction(check)] : []), ...(unplacedBefore ? [SET_SCENE_NOTE] : [])],
        {
          schema: check || !rollCheck ? schemas.noCheck : schemas.any,
          onText,
          onGeneration: (id) => (generation = id),
          signal: AbortSignal.any([signal, runaway.signal, early.signal]),
        },
        input,
        refusal,
        runaway.signal,
      ).catch((cause: unknown): string => {
        if (rated && !signal.aborted) return JSON.stringify({ check: rated });
        throw cause;
      });
      const response = parseReply<z.infer<typeof NarratorResponse | typeof EditedTurn>>(reply, edited === undefined ? NarratorResponse : EditedTurn);
      if (response.check) {
        if (check || !rollCheck) throw new InvalidResponse();
        check = rollCheck(response.check);
        attempt = 0; // The result call gets its own retries.
        continue;
      }
      const { state_operations, people, summary, recent_summary, scene_changed, visual_description, chapter_ends } = response;
      // Later replies copy marks like these, so they never reach a Save.
      let narration = edited ?? withoutStrayMarks(response.narration as string);
      // The last attempt keeps such a reply, as losing the Turn costs more than a long speech.
      // A picture without set_scene would be drawn from the last scene's place and people, which may have moved on. State Upkeep
      // brings the scene up to date, so with it the picture is kept; without it the reply is written again, then the picture dropped.
      // Never kept, even on the last attempt, as what isn't a story is no Turn.
      if (edited === undefined && check && declined(narration)) throw new InvalidResponse(undefined, { cause: DECLINED });
      if (edited === undefined && !hasWords(narration)) throw new InvalidResponse(undefined, { cause: NO_WORDS });
      if (edited === undefined && isJsonObject(narration)) throw new InvalidResponse(undefined, { cause: JSON_NARRATION });
      const unplaced = scene_changed && !state_operations.some(({ op }) => op === "set_scene") ? "a picture without set_scene" : undefined;
      const spoken = edited === undefined ? spokenLineFault(narration, pcName) : undefined;
      const choices = playMode === "choices" ? usableChoices(response.choices) : undefined;
      const unchosen = playMode === "choices" && !choices ? NO_CHOICES : undefined;
      // A long speech is only logged, as rewriting it restarted too many Turns the player could see.
      const noted = edited === undefined && isNoteAboutTurn(narration) ? NOTE_ABOUT_TURN : undefined;
      const fault =
        attempt < MAX_ATTEMPTS ? (noted ?? (upkeep ? undefined : unplaced) ?? (spoken === LONG_SPEECH ? undefined : spoken) ?? unchosen) : undefined;
      unplacedBefore = fault === unplaced && !!unplaced;
      if (fault) throw new InvalidResponse(undefined, { cause: fault });
      if (spoken === LONG_SPEECH) log.warning("turn", "Long speech kept", { attempt, generation });
      // The player picks again from a Regenerate, or switches to Free Text.
      if (unchosen) log.warning("turn", "Turn kept without Choices", { attempt, generation });
      // Checked before State Upkeep, so a reply that will be written again costs no call.
      const introducedBefore = introduce(before, people, pcName, state_operations);
      const narrated = applyOperations(introducedBefore.state, introducedBefore.operations);
      const clashesBefore = attempt < MAX_ATTEMPTS ? introducedBefore.refused : [];
      if (clashesBefore.length > 0 || narrated.refused.length > 0) throw new InvalidResponse(undefined, { cause: [...clashesBefore, ...narrated.refused] });
      let description = visual_description?.trim() ?? "";
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
        });
        const result = await checkConsistency(consistency, upkeep?.provider, reply, (text) => usableFix(withoutStrayMarks(text), pcName, told, check), signal);
        checked = result.checked;
        narration = withoutStrayMarks(result.narration);
        description = result.visualDescription;
        // Nothing tells the player, but the fixed reply takes the streamed one's place.
        if (narration !== told) emit("revise", { text: narration });
      }
      const upkept = upkeep ? await upkeepOperations(upkeep, pcName, narrated.next, check, previous, narration, signal) : undefined;
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
          repeated = repeats;
          ignored = harmless;
          if (summary.trim()) next.summary = summary.trim();
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
        choices,
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
        });
      } catch (error) {
        log.error("turn", "Image work after commit failed", errorFields(error));
      }
      if (repeated > 0) log.info("turn", "Repeats ignored", { count: repeated });
      if (ignored.length > 0) log.warning("turn", "Operations ignored", { reason: refusalText(ignored) });
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
      }));
      return messages;
    } catch (cause) {
      retry = `${retryIfInvalid(cause, attempt, input, generation)}, so the Narrator is writing it again (try ${attempt + 1} of ${MAX_ATTEMPTS}).`;
    }
  }
}

/** Whether a fix passes what a Narrator reply must. It may run a little longer than the reply it fixes. */
export function usableFix(text: string, pcName: string, told: string, check?: Check) {
  return (
    hasWords(text) &&
    !isJsonObject(text) &&
    !(check && declined(text)) &&
    ![PC_LINE, TAG_WITHOUT_BRACKET].includes(spokenLineFault(text, pcName) ?? "") &&
    withinLimit(text, Math.max(REPLY_WORDS, countWords(told)))
  );
}

/** Why the spoken lines break the reply's shape, if they do: a tag missing its "[", a line for the PC, or someone speaking more than twice. */
export function spokenLineFault(narration: string, pcName: string) {
  const lines = new Map<string, number>();
  for (const line of narration.split("\n").map((text) => text.trim())) {
    if (/^[^[\]\s][^[\]]*\]:/.test(line)) return TAG_WITHOUT_BRACKET;
    const speaker = line.match(/^\[([^[\]]+)\]:/)?.[1]?.trim();
    // The player alone writes what the PC says, and the prompt saying so was ignored.
    if (speaker && pcName && (speaker.toLowerCase() === pcName.toLowerCase() || (givenName(speaker) ?? "") === givenName(pcName))) return PC_LINE;
    if (speaker) lines.set(speaker, (lines.get(speaker) ?? 0) + 1);
  }
  return [...lines.values()].some((count) => count > 2) ? LONG_SPEECH : undefined;
}
const LONG_SPEECH = "someone speaks more than twice";
const TAG_WITHOUT_BRACKET = "a speaker tag without its [";
const PC_LINE = "a spoken line for the PC";

type Refusal = { op: string; reason: string };
const refusalText = (refusals: Refusal[]) => refusals.map(({ op, reason }) => `${op}: ${reason}`).join(", ");

/** What was wrong with a reply, without any of its text. */
function whyInvalid({ cause }: InvalidResponse) {
  if (typeof cause === "string") return cause;
  // A custom check's message is the app's own fixed words, never the reply's, so it may name what failed.
  if (cause instanceof z.ZodError) return cause.issues.map(({ path, code, message }) => `${path.join(".")}: ${code === "custom" ? message : code}`).join(", ");
  if (Array.isArray(cause)) return `refused operations: ${refusalText(cause)}`;
  // Not the parser's message, which quotes the reply.
  return cause instanceof SyntaxError ? "not JSON" : "a Check request where none is allowed";
}

/** What a player is told of an invalid reply, never quoting it, as a reply may hold secrets. */
function playerReason({ cause }: InvalidResponse) {
  if (cause === TAG_WITHOUT_BRACKET) return "A spoken line in the last reply was missing its speaker";
  if (cause === PC_LINE) return "The last reply spoke for your character";
  if (cause === "a picture without set_scene") return "The last reply moved to a new scene without saying where";
  if (cause === NO_CHOICES) return "The last reply offered no choices";
  if (cause === DECLINED) return "The last reply wasn't a story, which can mean the AI's content rules block this";
  if (cause === NOTE_ABOUT_TURN) return "The last reply was a note about the story instead of the story";
  if (cause === RAN_ON) return "The last reply ran on far too long";
  if (cause === OVERTHOUGHT) return "The AI thought for too long before writing";
  if (Array.isArray(cause)) return "The last reply changed the story in a way that doesn't fit what's already true";
  if (cause === undefined) return "The last reply asked for a second dice roll";
  return "The last reply came back garbled";
}

/** Returns, if another attempt should run, why it's needed in the player's words. Anything but an invalid reply goes on up. */
function retryIfInvalid(cause: unknown, attempt: number, input: string, generation: string | undefined) {
  if (!(cause instanceof InvalidResponse)) throw cause;
  const reason = whyInvalid(cause);
  log.warning("turn", "Unusable Narrator reply", { attempt, of: MAX_ATTEMPTS, reason, generation });
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
  const { scene_memory } = await askForJson(textProvider, memoryPrompt(batch, previous), SceneMemoryReply, "The model refused a batch of Messages.", signal);
  return scene_memory.trim();
}

const ChapterTitleReply = z.object({ title: z.string().trim().min(1).max(80) });

/** Throws as askForJson does. */
export async function askForChapterTitle(textProvider: TextProvider, memories: string[], recent: Message[], signal: AbortSignal) {
  const { title } = await askForJson(textProvider, chapterTitlePrompt(memories, recent), ChapterTitleReply, "The model refused to title the chapter.", signal);
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
  /** `lessThinking` asks for that many levels below the player's Thinking from the first attempt. */
  { picture = false, lessThinking: fewer = 0 } = {},
) {
  let generation: string | undefined;
  let lessThinking = fewer;
  let asked = prompt;
  for (let attempt = 1; ; attempt++) {
    const request = { schema: jsonSchemaOf(schema), picture, lessThinking, onText: () => {}, onGeneration: (id: string) => (generation = id), signal };
    try {
      return parseReply(await askNarrator(textProvider, asked, request, "", refusal), schema);
    } catch (cause) {
      retryIfInvalid(cause, attempt, "", generation);
      const reason = whyInvalid(cause as InvalidResponse);
      // The same level would most likely think past the limit again.
      if (reason === OVERTHOUGHT) lessThinking++;
      // After the prompt, so the provider's cache still holds, and in the app's own words, never the reply's.
      else asked = [...prompt, { role: "system", content: `Your last reply couldn't be used: ${reason}. Reply again, fixing that.` }];
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
