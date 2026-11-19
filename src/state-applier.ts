import { z } from "zod";

export type LoreEntry = { title: string; keywords: string[]; content: string; alwaysOn: boolean };

export type SceneMemory = { firstMessage: number; lastMessage: number; text: string };

export type State = {
  inventory: { wearing: string[]; carrying: string[] };
  status: { health: string; injuries: string[]; conditions: string[] };
  npcs: { name: string; appearance: string }[];
  /** What each NPC has learned or lived through in play, newest last, by name. Hidden from the player, as it can hold what the PC never saw. */
  npcKnows: Record<string, string[]>;
  scene: { location: string; visibleCast: string[] };
  /** `summaries` says who each known NPC is, as the PC understands it. A Save from before them has none. */
  pcKnown: { facts: string[]; npcs: string[]; summaries?: Record<string, string> };
  /** What the PC knows is still unresolved. Unlike a Plot Thread, the player reads these. */
  looseEnds: string[];
  /** The story's older Messages in about 100 words each, oldest first. The server sets each range, so a wrong memory can be traced to its source. */
  sceneMemories: SceneMemory[];
  worldBible: LoreEntry[];
  worldRules: string[];
  /** Each Plot Thread's truth: what really happened, who is behind it, what they want and what is hidden. It changes only when play reveals it. */
  plotThreads: string[];
  /**
   * Each Plot Thread's now, by its truth: what its people are doing and will do next, out of the PC's sight. World Moves On
   * rewrites it freely, as rewriting a thread's one text lost who was behind it and what it hid. A Save from before it has none.
   */
  threadsNow: Record<string, string>;
  /**
   * By each Plot Thread's truth, who World Moves On gave their own part of it, kept in npcKnows. Apart from what they learn in
   * play, as a move took anything in npcKnows for their part and never gave the people with only that one. A Save from before it has none.
   */
  threadParts: Record<string, string[]>;
  summary: string;
  /** Just the last few scenes, for the player. The Narrator never reads it back. */
  recentSummary: string;
  directorsNotes: string[];
  /** Here rather than on the Save, so a Revert undoes an edit to it. */
  worldBrief: string;
  /** Closed Chapters, oldest first. A null `lastMessage` was closed after the latest Message, and the next Turn fills it in. */
  chapters: Chapter[];
  /** Whether the latest Narrator reply suggested ending the open Chapter. */
  chapterReady: boolean;
  /** Null until the Narrator first sets it, as in a Save from before Story Time. */
  storyTime: StoryTime | null;
  /** How the PC's body and face look now, once the story changes them. Empty until then, when the PC's own physicalTraits stand. */
  pcAppearance: string;
  /** The real era and region every picture resembles, set once so pictures don't drift between eras. Empty until the Narrator sets it. */
  era: string;
};

/** `day` counts days since the Opening, as Narrators add whole numbers far better than they work an in-world calendar. The player never sees it. */
export type StoryTime = { day: number; date: string; timeOfDay: string };

export type Chapter = { lastMessage: number | null; title: string };

export const openingState: State = {
  inventory: { wearing: [], carrying: [] },
  status: { health: "unhurt", injuries: [], conditions: [] },
  npcs: [],
  npcKnows: {},
  scene: { location: "", visibleCast: [] },
  pcKnown: { facts: [], npcs: [] },
  looseEnds: [],
  sceneMemories: [],
  worldBible: [],
  worldRules: [],
  plotThreads: [],
  threadsNow: {},
  threadParts: {},
  summary: "",
  recentSummary: "",
  directorsNotes: [],
  worldBrief: "",
  chapters: [],
  chapterReady: false,
  storyTime: null,
  pcAppearance: "",
  era: "",
};

const stringList = z.array(z.string());

/** What each Snapshot section must hold, for a Save that comes from outside the app. */
export const StateSections = {
  inventory: z.object({ wearing: stringList, carrying: stringList }),
  status: z.object({ health: z.string(), injuries: stringList, conditions: stringList }),
  npcs: z.array(z.object({ name: z.string(), appearance: z.string() })),
  npcKnows: z.record(z.string(), stringList),
  scene: z.object({ location: z.string(), visibleCast: stringList }),
  pcKnown: z.object({ facts: stringList, npcs: stringList, summaries: z.record(z.string(), z.string()).optional() }),
  looseEnds: stringList,
  sceneMemories: z.array(z.object({ firstMessage: z.number().int(), lastMessage: z.number().int(), text: z.string() })),
  worldBible: z.array(z.object({ title: z.string(), keywords: stringList, content: z.string(), alwaysOn: z.boolean() })),
  worldRules: stringList,
  plotThreads: stringList,
  threadsNow: z.record(z.string(), z.string()),
  threadParts: z.record(z.string(), stringList),
  summary: z.string(),
  recentSummary: z.string(),
  directorsNotes: stringList,
  worldBrief: z.string(),
  chapters: z.array(z.object({ lastMessage: z.number().int().nullable(), title: z.string() })),
  chapterReady: z.boolean(),
  storyTime: z.object({ day: z.number().int(), date: z.string(), timeOfDay: z.string() }).nullable(),
  pcAppearance: z.string(),
  era: z.string(),
} satisfies { [Section in keyof State]: z.ZodType<State[Section]> };

const nonEmpty = z.string().min(1);
const statusKind = z.enum(["injuries", "conditions"]);

export const StateOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_item"), slot: z.enum(["wearing", "carrying"]), item: nonEmpty }),
  z.object({ op: z.literal("remove_item"), item: nonEmpty }),
  z.object({ op: z.literal("set_health"), health: nonEmpty }),
  z.object({ op: z.literal("add_status"), kind: statusKind, text: nonEmpty }),
  z.object({ op: z.literal("remove_status"), kind: statusKind, text: nonEmpty }),
  z.object({ op: z.literal("add_npc"), name: nonEmpty, appearance: nonEmpty }),
  z.object({ op: z.literal("update_npc"), name: nonEmpty, appearance: nonEmpty }),
  z.object({ op: z.literal("merge_npc"), name: nonEmpty, into: nonEmpty }),
  z.object({
    op: z.literal("npc_learns"),
    name: nonEmpty,
    fact: nonEmpty.describe("one short sentence of what this NPC learned or lived through in play, as they would remember it"),
  }),
  z.object({ op: z.literal("set_scene"), location: nonEmpty, visible_cast: z.array(nonEmpty) }),
  z.object({ op: z.literal("add_known_fact"), fact: nonEmpty }),
  z.object({ op: z.literal("update_known_fact"), fact: nonEmpty, replacement: nonEmpty }),
  z.object({ op: z.literal("remove_known_fact"), fact: nonEmpty }),
  z.object({ op: z.literal("add_known_npc"), name: nonEmpty }),
  z.object({ op: z.literal("set_known_npc_summary"), name: nonEmpty, summary: nonEmpty }),
  z.object({ op: z.literal("add_loose_end"), loose_end: nonEmpty }),
  z.object({ op: z.literal("resolve_loose_end"), loose_end: nonEmpty }),
  z.object({
    op: z.literal("add_lore_entry"),
    title: nonEmpty,
    keywords: z.array(nonEmpty).min(1),
    content: nonEmpty,
  }),
  z.object({
    op: z.literal("update_lore_entry"),
    title: nonEmpty,
    keywords: z.array(nonEmpty).min(1),
    content: nonEmpty,
  }),
  z.object({ op: z.literal("remove_lore_entry"), title: nonEmpty }),
  z.object({ op: z.literal("update_plot_thread"), thread: nonEmpty, now: nonEmpty, truth: nonEmpty.nullable().default(null) }),
  z.object({ op: z.literal("resolve_plot_thread"), thread: nonEmpty }),
  z.object({ op: z.literal("set_pc_appearance"), appearance: nonEmpty }),
  z.object({ op: z.literal("set_era"), era: nonEmpty }),
  z.object({ op: z.literal("set_story_time"), days_passed: z.number().int().min(0), date: nonEmpty.nullable(), time_of_day: nonEmpty }),
]);
export type StateOperation = z.infer<typeof StateOperation>;

const findNpc = (state: State, name: string) => state.npcs.find((npc) => npc.name === name);

export const named = (full: string, mark: string) => full.toLowerCase() === mark.toLowerCase() || full.toLowerCase().split(" ").includes(mark.toLowerCase());

/** Narrators shorten names, so part of one counts when it can only mean one person. */
export function findPerson<Npc extends { name: string }>(npcs: Npc[], mark: string) {
  const exact = npcs.find(({ name }) => name === mark);
  if (exact) return exact;
  const partly = npcs.filter(({ name }) => named(name, mark));
  return partly.length === 1 ? partly[0] : undefined;
}

const itemWords = (item: string) =>
  ` ${
    item
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.join(" ") ?? ""
  } `;
/** Whether two items are one: the same words, or one holding all of the other's two words or more in a row. */
const sameItem = (held: string, item: string) => {
  const [shorter, longer] = [itemWords(held), itemWords(item)].sort((a, b) => a.length - b.length) as [string, string];
  return shorter === longer || (shorter.trim().includes(" ") && longer.includes(shorter));
};

function take(list: string[], value: string) {
  const index = list.indexOf(value);
  if (index === -1) return false;
  list.splice(index, 1);
  return true;
}

// Status reads as words in the story, never as points or percentages.
// shortcut: spelled-out numbers pass and only the Narrator prompt stops them, screen them if models write them.
export const hasNumber = (text: string) => /\p{N}/u.test(text);

/** The most injuries, and the most conditions, the PC keeps, so the status the player reads stays a line or two. */
export const MAX_STATUS = 3;

/** The most Plot Threads the Narrator keeps open, so it isn't pulling on a dozen at once. A world starts with three to six. */
export const MAX_PLOT_THREADS = 8;

/** The most an NPC's list of what they know keeps, newest last, so the lists of a crowded scene stay a few lines each. */
export const MAX_NPC_KNOWS = 12;

function addOnce(list: string[], value: string) {
  if (list.includes(value)) return false;
  list.push(value);
  return true;
}

/**
 * Puts `replacement` where `value` was, or on the end if `value` isn't there, as a long text is easily miscopied and
 * that isn't worth a whole response. If `replacement` is already there, the two versions become one.
 */
function replaceOnce(list: string[], value: string, replacement: string) {
  const index = list.indexOf(value);
  take(list, value);
  if (!list.includes(replacement)) list.splice(index === -1 ? list.length : index, 0, replacement);
}

// Words shorter than four letters are skipped too, so these are only the common longer ones.
const COMMON_WORDS = new Set([
  "that",
  "this",
  "with",
  "from",
  "they",
  "their",
  "them",
  "have",
  "been",
  "will",
  "into",
  "when",
  "what",
  "were",
  "than",
  "then",
  "there",
  "about",
  "would",
  "which",
  "while",
]);
const wordsOf = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .match(/[\p{L}\p{N}]{4,}/gu)
      ?.filter((word) => !COMMON_WORDS.has(word)),
  );

/**
 * The thread `text` names: itself, or else the one sharing most of its words, as Narrators paraphrase a long thread they
 * were told to copy. Threads in one story share names, so it takes half the longer one's words, and a tie is no match.
 */
export function closestThread(threads: string[], text: string) {
  if (threads.includes(text)) return text;
  const words = wordsOf(text);
  const scored = threads.map((thread) => {
    const theirs = wordsOf(thread);
    return { thread, score: [...words].filter((word) => theirs.has(word)).length / Math.max(words.size, theirs.size, 1) };
  });
  const [best, next] = scored.sort((a, b) => b.score - a.score);
  return best && best.score >= 0.5 && best.score !== next?.score ? best.thread : undefined;
}

/**
 * Makes `name` and `into` one person, or renames `name` if `into` isn't in the state. Someone already gone is no reason to
 * lose a response. Portraits stay as they are, so a Revert needs nothing undone: the known list hides the merged one's.
 */
function mergeNpc(state: State, name: string, into: string) {
  const npc = findNpc(state, name);
  if (!npc || name === into) return;
  const { pcKnown, scene } = state;
  if (findNpc(state, into)) state.npcs = state.npcs.filter((other) => other !== npc);
  else npc.name = into;
  if (pcKnown.npcs.includes(name)) replaceOnce(pcKnown.npcs, name, into);
  if (scene.visibleCast.includes(name)) replaceOnce(scene.visibleCast, name, into);
  const { [name]: summary, ...summaries } = pcKnown.summaries ?? {};
  if (summary !== undefined) pcKnown.summaries = { [into]: summary, ...summaries };
  mergeNpcKnows(state, name, into);
}

function mergeNpcKnows(state: State, name: string, into: string) {
  if (!Object.hasOwn(state.npcKnows, name)) return;
  const { [name]: knew = [], ...knows } = state.npcKnows;
  const kept = Object.hasOwn(knows, into) ? knows[into]! : [];
  // The kept one's own last, shared ones too, so the cap drops the other's first.
  state.npcKnows = { ...knows, [into]: [...knew.filter((fact) => !kept.includes(fact)), ...kept].slice(-MAX_NPC_KNOWS) };
}

/** What this reply made of each Plot Thread's truth it changed, its amended truth or null once resolved. */
type ThreadsSoFar = { became: Map<string, string | null>; held?: Set<string> };

/**
 * The open thread `text` names, followed to what this reply made of it, so that a thread already changed is never matched
 * to another that shares its words. `resolved` when this reply closed it.
 */
function namedThread(state: State, text: string, { became }: ThreadsSoFar) {
  // Only those the prompt showed, as a Save from before the limit can hold more.
  const shown = state.plotThreads.slice(0, MAX_PLOT_THREADS);
  // Once each, as a thread in two lists would tie with itself and match nothing.
  const named = closestThread([...new Set([...shown, ...became.keys()])], text);
  if (named === undefined || shown.includes(named)) return { thread: named };
  let now: string | null | undefined = named;
  // A few steps at most, in case a reply rewrites a thread back and forth.
  for (let step = 0; typeof now === "string" && !shown.includes(now) && became.has(now) && step < MAX_PLOT_THREADS; step++) now = became.get(now);
  return now === null ? { resolved: true } : { thread: now };
}

/** Changes `state` and returns nothing, or returns why `operation` is disproved, having changed nothing. The reason goes to the Server Log, so it never quotes the operation. */
function apply(state: State, operation: StateOperation, threads: ThreadsSoFar = { became: new Map() }): string | undefined {
  switch (operation.op) {
    case "add_item": {
      // Worn or carried, the same thing held twice was the same notebook three times and a shawl both worn and carried. A fuller
      // name replaces the old where it is, as models restate what is held with how it is now.
      // The same words twice in one reply may be two of a thing, as "two lengths of rope" are, so only one held before it repeats.
      for (const list of [state.inventory.wearing, state.inventory.carrying]) {
        const at = list.findIndex((held) => sameItem(held, operation.item));
        if (at < 0) continue;
        if (itemWords(list[at]!) !== itemWords(operation.item)) list[at] = operation.item;
        else if (!threads.held?.has(itemWords(operation.item))) break;
        else return "already there";
        return;
      }
      state.inventory[operation.slot].push(operation.item);
      return;
    }
    case "remove_item":
      if (take(state.inventory.carrying, operation.item) || take(state.inventory.wearing, operation.item)) return;
      // The old name of what an add just gave a fuller one, as a reply adds the new and removes the old: it is the same thing, still held.
      return [...state.inventory.wearing, ...state.inventory.carrying].some((held) => sameItem(held, operation.item)) ? undefined : "not held";
    case "set_health":
      if (hasNumber(operation.health)) return "has a number";
      state.status.health = operation.health;
      return;
    case "add_status":
      if (hasNumber(operation.text)) return "has a number";
      if (!addOnce(state.status[operation.kind], operation.text)) return "already there";
      // The oldest goes, as Narrators often forget to remove what has passed.
      state.status[operation.kind] = state.status[operation.kind].slice(-MAX_STATUS);
      return;
    case "remove_status":
      return take(state.status[operation.kind], operation.text) ? undefined : "not there";
    case "add_npc": {
      // No two people share a name, so adding someone already there gives them the looks they now have, as update_npc would.
      const npc = findNpc(state, operation.name);
      if (npc) npc.appearance = operation.appearance;
      else state.npcs.push({ name: operation.name, appearance: operation.appearance });
      // What World Moves On gave them to know before they were met, under the name a thread gave them.
      const unmet = Object.keys(state.npcKnows).find(
        (name) => name !== operation.name && !findNpc(state, name) && (named(operation.name, name) || named(name, operation.name)),
      );
      if (unmet) mergeNpcKnows(state, unmet, operation.name);
      return;
    }
    case "update_npc": {
      const npc = findNpc(state, operation.name);
      if (!npc) return "no such NPC";
      npc.appearance = operation.appearance;
      return;
    }
    case "merge_npc":
      mergeNpc(state, operation.name, operation.into);
      return;
    case "npc_learns": {
      // A reply squeezed by its schema can send a scrap here, and then they just know less.
      const name = findPerson(state.npcs, operation.name)?.name;
      if (!name) return "no such NPC";
      if (!/\p{L}/u.test(operation.fact)) return "no words";
      // Own keys only, as a name such as "constructor" would find what every object has.
      const knows = Object.hasOwn(state.npcKnows, name) ? state.npcKnows[name]! : [];
      if (!addOnce(knows, operation.fact)) return "already there";
      state.npcKnows = { ...state.npcKnows, [name]: knows.slice(-MAX_NPC_KNOWS) };
      return;
    }
    case "set_scene": {
      // The cast only steers images, so a name the state lacks is left out rather than failing the Turn.
      const visibleCast = [...new Set(operation.visible_cast)].filter((name) => findNpc(state, name));
      state.scene = { location: operation.location, visibleCast };
      return;
    }
    // A repeat is already true, so it costs nothing, and refusing one would throw away a whole response.
    case "add_known_fact":
      addOnce(state.pcKnown.facts, operation.fact);
      return;
    case "update_known_fact":
      replaceOnce(state.pcKnown.facts, operation.fact, operation.replacement);
      return;
    case "remove_known_fact":
      take(state.pcKnown.facts, operation.fact);
      return;
    case "add_known_npc":
      if (!findNpc(state, operation.name)) return "no such NPC";
      addOnce(state.pcKnown.npcs, operation.name);
      return;
    case "set_known_npc_summary":
      if (!state.pcKnown.npcs.includes(operation.name)) return "NPC not known";
      state.pcKnown.summaries = { ...state.pcKnown.summaries, [operation.name]: operation.summary };
      return;
    case "add_loose_end":
      addOnce(state.looseEnds, operation.loose_end);
      return;
    case "resolve_loose_end":
      return take(state.looseEnds, operation.loose_end) ? undefined : "not there";
    case "add_lore_entry": {
      const { title, keywords, content } = operation;
      // The Narrator only sees activated entries, so it can repeat a title innocently: keep the first, not fail the Turn.
      if (state.worldBible.some((entry) => entry.title === title)) return;
      // Always-on entries bypass the token budget, so the Narrator can only add keyword-activated ones.
      state.worldBible.push({ title, keywords, content, alwaysOn: false });
      return;
    }
    case "update_lore_entry": {
      const { title, keywords, content } = operation;
      const entry = state.worldBible.find((lore) => lore.title === title);
      // Always-on entries bypass the token budget, so the Narrator can't grow one.
      if (entry?.alwaysOn) return;
      if (entry) Object.assign(entry, { keywords, content });
      else state.worldBible.push({ title, keywords, content, alwaysOn: false });
      return;
    }
    case "remove_lore_entry":
      state.worldBible = state.worldBible.filter(({ title, alwaysOn }) => alwaysOn || title !== operation.title);
      return;
    case "update_plot_thread": {
      const { thread, resolved } = namedThread(state, operation.thread, threads);
      // Closed earlier in this reply, so a rewrite mustn't open it again.
      if (resolved) return;
      // Not added, as a Turn adds no thread: World Moves On does. A DeepSeek Turn's unmatched rewrites took three threads to six.
      if (thread === undefined) return "matches no thread";
      const truth = operation.truth ?? thread;
      const { [thread]: _was, ...others } = state.threadsNow;
      state.threadsNow = { ...others, [truth]: operation.now };
      const { [thread]: parts, ...otherParts } = state.threadParts;
      if (parts) state.threadParts = { ...otherParts, [truth]: parts };
      replaceOnce(state.plotThreads, thread, truth);
      if (thread !== truth) threads.became.set(thread, truth);
      return;
    }
    case "resolve_plot_thread": {
      const { thread, resolved } = namedThread(state, operation.thread, threads);
      if (resolved) return;
      // Ignored, not refused, as DeepSeek resolved threads long gone, which failed whole Turns.
      if (thread === undefined || !take(state.plotThreads, thread)) return "matches no thread";
      const { [thread]: _gone, ...open } = state.threadsNow;
      state.threadsNow = open;
      const { [thread]: _parts, ...openParts } = state.threadParts;
      state.threadParts = openParts;
      threads.became.set(thread, null);
      return;
    }
    case "set_pc_appearance":
      state.pcAppearance = operation.appearance;
      return;
    case "set_era":
      // Set once, as changing it later is the drift it exists to stop.
      if (state.era) return "already there";
      state.era = operation.era;
      return;
    case "set_story_time": {
      const { time_of_day } = operation;
      // The date wins over days_passed when they disagree, as models gave the day count there, doubling it each time (day 280 in 30 rounds).
      const days_passed = operation.date === state.storyTime?.date ? 0 : operation.days_passed;
      // A new day kept on the old date would put the story on the wrong day, so it waits for a Turn that names one.
      const date = operation.date ?? (days_passed === 0 ? state.storyTime?.date : undefined);
      if (date === undefined) return "no date";
      // Never back within a day, as a reply that did so had started the story over from its first morning.
      const [was, now] = [dayPart(state.storyTime?.timeOfDay), dayPart(time_of_day)];
      // From night on, the small hours and the next morning come after, as "past midnight" refused them all for five rounds.
      const wraps = was !== undefined && was >= NIGHT && now !== undefined && (now >= NIGHT || now <= MORNING);
      if (days_passed === 0 && date === state.storyTime?.date && was !== undefined && now !== undefined && now < was && !wraps) return "earlier than now";
      state.storyTime = { day: (state.storyTime?.day ?? 1) + days_passed, date, timeOfDay: withoutDate(time_of_day, date) };
      return;
    }
  }
}

/** The time of day without the parts that only repeat the date, as "mid-morning, Tuesday 16th October" showed the date twice. */
function withoutDate(timeOfDay: string, date: string) {
  const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const inDate = new Set(words(date));
  const parts = timeOfDay.split(/\s*,\s*/).filter((part) => !words(part).every((word) => inDate.has(word)));
  return parts.length > 0 ? parts.join(", ") : timeOfDay;
}

// First match wins, so "afternoon" isn't read as "noon" nor "midnight" as "night".
const DAY_PARTS: [RegExp, number][] = [
  [/midnight/i, 7],
  [/afternoon/i, 4],
  [/evening|dusk|sunset/i, 5],
  [/night/i, 6],
  [/noon|midday/i, 3],
  [/dawn|sunrise|daybreak|early morning/i, 1],
  [/morning/i, 2],
];
const [MORNING, NIGHT] = [2, 6];
/** Where in the day a time of day falls, in order, or undefined for words that don't say. */
const dayPart = (timeOfDay = "") => DAY_PARTS.find(([words]) => words.test(timeOfDay))?.[1];

const isRepeat = ({ pcKnown, looseEnds }: State, operation: StateOperation) =>
  (operation.op === "add_known_fact" && pcKnown.facts.includes(operation.fact)) ||
  (operation.op === "add_known_npc" && pcKnown.npcs.includes(operation.name)) ||
  (operation.op === "add_loose_end" && looseEnds.includes(operation.loose_end));

// None of these contradict the narration, so they aren't worth a whole response. Someone nameless is added once they're named.
const IGNORABLE: StateOperation["op"][] = ["resolve_loose_end", "add_known_npc", "set_known_npc_summary", "set_story_time", "npc_learns"];
const isHarmless = ({ op, reason }: { op: StateOperation["op"]; reason: string }) =>
  IGNORABLE.includes(op) || reason === "already there" || reason === "matches no thread";

/** Applies operations in order, so each is judged against the ones before it. */
export function applyOperations(state: State, operations: StateOperation[]) {
  const next = structuredClone(state);
  let repeats = 0;
  const threads: ThreadsSoFar = { became: new Map(), held: new Set([...state.inventory.wearing, ...state.inventory.carrying].map(itemWords)) };
  const refusals = operations.flatMap(({ ...operation }) => {
    if (isRepeat(next, operation)) repeats++;
    const reason = apply(next, operation, threads);
    return reason ? [{ op: operation.op, reason }] : [];
  });
  return { next, refused: refusals.filter((refusal) => !isHarmless(refusal)), ignored: refusals.filter(isHarmless), repeats };
}

export type World = Pick<State, "worldBible" | "worldRules" | "plotThreads">;

const words = z.string().trim().min(1);
// Untrimmed, as a quote must match what a Turn stored, and Turns store text as it came.
const quote = z.string().min(1);
export const namesSomething = (change: { old: string | null; new: string | null }) => change.old !== null || change.new !== null;

export const LoreEntryReply = z.object({ title: words, keywords: z.array(words).min(3), content: words });

/** One entry of a list: replaces `old`, or adds when `old` is null, or removes it when `new` is null. */
export const ListChange = z.object({ old: quote.nullable(), new: words.nullable() }).refine(namesSomething);
export type ListChange = z.infer<typeof ListChange>;

/** A change to a world already written, holding only what changes, so a reply can't lose an entry by leaving it out. Each Lore Entry is added, or replaces the one with its exact title. */
export const WorldUpdate = z.object({
  lore_entries: z.array(LoreEntryReply),
  removed_lore: z.array(quote),
  world_rules: z.array(ListChange),
  plot_threads: z.array(ListChange),
});
export type WorldUpdate = z.infer<typeof WorldUpdate>;

/** An edit can outlive the entry it names, when a replaced response took that entry away, so a missing `old` adds rather than failing. */
export function changeList(list: string[], change: ListChange) {
  const at = change.old === null ? -1 : list.indexOf(change.old);
  const added = change.new === null ? [] : [change.new];
  return [...new Set(at < 0 ? [...list, ...added] : list.toSpliced(at, 1, ...added))];
}

export function mergeWorldUpdate(world: World, update: WorldUpdate): World {
  const written = new Map(update.lore_entries.map((entry) => [entry.title, entry]));
  const kept = world.worldBible.filter(({ title }) => !update.removed_lore.includes(title));
  const added = update.lore_entries.filter(({ title }) => !kept.some((entry) => entry.title === title));
  return {
    worldBible: [
      ...kept.map((entry) => ({ ...entry, ...written.get(entry.title) })),
      // Always-on entries bypass the token budget, so the Narrator can only add keyword-activated ones.
      ...added.map((entry) => ({ ...entry, alwaysOn: false })),
    ],
    worldRules: update.world_rules.reduce(changeList, world.worldRules),
    plotThreads: update.plot_threads.reduce(changeList, world.plotThreads),
  };
}

/** What the player can change directly, which is all text they can already read. */
export const VisibleEdit = z.discriminatedUnion("edit", [
  z.object({ edit: z.literal("worldBrief"), text: words }),
  z.object({ edit: z.literal("summary"), text: words }),
  z.object({ edit: z.literal("recentSummary"), text: words }),
  z.object({ edit: z.literal("fact"), old: quote.nullable(), new: words.nullable() }).refine(namesSomething),
  z.object({ edit: z.literal("looseEnd"), old: quote.nullable(), new: words.nullable() }).refine(namesSomething),
  z.object({ edit: z.literal("npcSummary"), name: words, text: words }),
  // Text only: the range stays the server's. Never give a Narrator reply this edit, as no model rewrites a stored memory.
  z.object({ edit: z.literal("sceneMemory"), firstMessage: z.number().int(), text: words }),
  // The place in `chapters`, as titles needn't be unique.
  z.object({ edit: z.literal("chapterTitle"), index: z.number().int().min(0), title: words }),
  // Never the day count, which only measures the days played.
  z.object({ edit: z.literal("storyTime"), date: words, timeOfDay: words }),
]);

export type VisibleEdit = z.infer<typeof VisibleEdit>;

/** A change made between Messages. Snapshots are immutable, so these wait on the Save for the next Message to store. */
export const WorldEdit = z.discriminatedUnion("edit", [
  ...VisibleEdit.options,
  // `made` counts the edits just before it that the same World Change wrote, which a Save from before it lacks.
  // `moved` marks World Moves On's, which settles none of the player's Journal edits and rests on the reply it followed.
  // `now` sets the now of each thread it names by its truth, after `update`, which a Save from before it lacks.
  z.object({
    edit: z.literal("world"),
    update: WorldUpdate,
    now: z.record(z.string(), z.string()).optional(),
    made: z.number().int().min(0).optional(),
    moved: z.boolean().optional(),
    // World Moves On's: by name, each person's own part of the threads it wrote, kept as what they know.
    knows: z.record(z.string(), z.array(z.string())).optional(),
    // By truth, who those parts went to.
    parts: z.record(z.string(), z.array(z.string())).optional(),
  }),
  // Whole lists, as a World Change rewrites what the player says is wrong rather than one item at a time.
  z.object({ edit: z.literal("inventory"), wearing: z.array(z.string()), carrying: z.array(z.string()) }),
  z.object({ edit: z.literal("status"), health: z.string(), injuries: z.array(z.string()), conditions: z.array(z.string()) }),
  // Hidden like the rest of an NPC's looks, so only a World Change writes it.
  z.object({ edit: z.literal("npcLooks"), name: z.string(), appearance: z.string() }),
  z.object({ edit: z.literal("pcLooks"), appearance: z.string() }),
  // Only the server closes a Chapter, as it writes the title.
  z.object({ edit: z.literal("closeChapter"), title: z.string() }),
]);
export type WorldEdit = z.infer<typeof WorldEdit>;

/** The edits the player made themselves, leaving out each World Change and the edits it wrote. */
export function playersOwn(edits: WorldEdit[]) {
  const own: WorldEdit[] = [];
  for (const edit of edits) {
    if (edit.edit === "world") own.splice(own.length - (edit.made ?? 0));
    else own.push(edit);
  }
  return own;
}

export function applyEdit(state: State, edit: WorldEdit): State {
  switch (edit.edit) {
    case "worldBrief":
      return { ...state, worldBrief: edit.text };
    case "summary":
      return { ...state, summary: edit.text };
    case "recentSummary":
      return { ...state, recentSummary: edit.text };
    case "fact":
      return { ...state, pcKnown: { ...state.pcKnown, facts: changeList(state.pcKnown.facts, edit) } };
    case "looseEnd":
      return { ...state, looseEnds: changeList(state.looseEnds, edit) };
    case "npcSummary":
      return { ...state, pcKnown: { ...state.pcKnown, summaries: { ...state.pcKnown.summaries, [edit.name]: edit.text } } };
    // A replaced response can take the memory away, and with it what this names, so a miss changes nothing.
    case "sceneMemory":
      return {
        ...state,
        sceneMemories: state.sceneMemories.map((memory) => (memory.firstMessage === edit.firstMessage ? { ...memory, text: edit.text } : memory)),
      };
    case "world": {
      const merged = mergeWorldUpdate(state, edit.update);
      // A truth a World Change rewrites starts with no now, as the old one may no longer fit it, until the world next moves on.
      const now = { ...state.threadsNow, ...edit.now };
      const threadsNow = Object.fromEntries(merged.plotThreads.flatMap((truth) => (Object.hasOwn(now, truth) ? [[truth, now[truth]!]] : [])));
      // Under the name of someone met, or as named until they are, when add_npc takes it up.
      const npcKnows = { ...state.npcKnows };
      for (const [name, parts] of Object.entries(edit.knows ?? {})) {
        const key = findPerson(state.npcs, name)?.name ?? name;
        const knew = Object.hasOwn(npcKnows, key) ? npcKnows[key]! : [];
        npcKnows[key] = [...knew, ...parts.filter((part) => !knew.includes(part))].slice(-MAX_NPC_KNOWS);
      }
      const had = (truth: string) => (Object.hasOwn(state.threadParts, truth) ? state.threadParts[truth]! : []);
      const given = (truth: string) => (edit.parts && Object.hasOwn(edit.parts, truth) ? edit.parts[truth]! : []);
      const threadParts = Object.fromEntries(
        merged.plotThreads.flatMap((truth) => {
          const names = [...new Set([...had(truth), ...given(truth)])];
          return names.length > 0 ? [[truth, names]] : [];
        }),
      );
      return { ...state, ...merged, threadsNow, npcKnows, threadParts };
    }
    case "inventory":
      return { ...state, inventory: { wearing: edit.wearing, carrying: edit.carrying } };
    case "pcLooks":
      return { ...state, pcAppearance: edit.appearance };
    case "npcLooks":
      return { ...state, npcs: state.npcs.map((npc) => (npc.name === edit.name ? { ...npc, appearance: edit.appearance } : npc)) };
    case "status":
      return { ...state, status: { health: edit.health, injuries: edit.injuries.slice(-MAX_STATUS), conditions: edit.conditions.slice(-MAX_STATUS) } };
    case "storyTime":
      return { ...state, storyTime: { day: state.storyTime?.day ?? 1, date: edit.date, timeOfDay: edit.timeOfDay } };
    case "chapterTitle":
      return { ...state, chapters: state.chapters.map((chapter, index) => (index === edit.index ? { ...chapter, title: edit.title } : chapter)) };
    // A second close before any new Message would make an empty Chapter.
    case "closeChapter":
      return state.chapters.at(-1)?.lastMessage === null
        ? state
        : { ...state, chapters: [...state.chapters, { lastMessage: null, title: edit.title }], chapterReady: false };
  }
}

export const Person = z.object({ name: z.string().trim().min(1), appearance: z.string() });

/**
 * Makes everyone a response names a known NPC, as Narrators often forget to, ahead of `operations`, so that those can
 * use the new names. Returns the state and what's left of `operations` once anything this already did is taken out.
 */
export function introduce(state: State, people: z.infer<typeof Person>[], pcName: string, operations: StateOperation[]) {
  // Someone shortened to a name only one person has is that person, not someone new.
  const known = (name: string) => findPerson(state.npcs, name)?.name;
  // A list of people is never worth a Turn, so someone with no looks waits until they're named again. Each name once, the first
  // listing, as a second add_npc would give them its looks.
  const listed = new Set<string>();
  const introductions = people
    .filter(({ name, appearance }) => !named(pcName, name) && (known(name) || appearance.trim()))
    .filter(({ name }) => !listed.has(name) && listed.add(name))
    .flatMap(({ name, appearance }): StateOperation[] => {
      const kept = known(name) ?? name;
      return [
        ...(known(name) ? [] : [{ op: "add_npc" as const, name, appearance }]),
        ...(state.pcKnown.npcs.includes(kept) ? [] : [{ op: "add_known_npc" as const, name: kept }]),
      ];
    });
  // Two people with one given name can't be told apart, by the player or by the matching above.
  const taken = new Set([pcName, ...state.npcs.map(({ name }) => name)].map(givenName));
  // A full name learned later is added and the short one merged into it, as the prompt asks.
  const merging = new Set(operations.flatMap((operation) => (operation.op === "merge_npc" ? [operation.into] : [])));
  // Each name once, as a reply often lists someone in people and adds them in its operations too.
  const added = new Set(
    [...introductions, ...operations].flatMap((operation) =>
      operation.op === "add_npc" && !findNpc(state, operation.name) && !merging.has(operation.name) ? [operation.name] : [],
    ),
  );
  const refused = [...added].flatMap((name) => {
    const given = givenName(name);
    if (!given) return [];
    if (!taken.has(given)) {
      taken.add(given);
      return [];
    }
    return [{ op: "add_npc" as const, reason: "a given name someone already has" }];
  });
  return {
    state: applyOperations(state, introductions).next,
    operations: operations.filter(
      (operation) => !introductions.some((done) => done.op === operation.op && "name" in done && "name" in operation && done.name === operation.name),
    ),
    refused,
  };
}

// Articles and titles only: words such as "old" describe someone rather than stand before their name.
const TITLES = new Set(
  "the a an mr mrs ms miss mx dr doctor sir dame lady lord madam officer detective captain father mother sister brother aunt uncle".split(" "),
);
const PARTICLES = new Set(["van", "von", "de", "der", "den", "del", "della", "di", "da", "du", "la", "le", "bin", "ibn", "al", "el", "y", "dos", "das"]);

/**
 * The first word of a name after any title, or none for a description such as "Man in grey windbreaker", which has
 * lowercase words that aren't part of a name.
 */
// shortcut: titles and name particles are short English-leaning lists, add to them if a real name is refused or a description clashes.
export function givenName(name: string) {
  const words = name.trim().split(/\s+/);
  if (words.some((word, at) => at > 0 && /^\p{Ll}/u.test(word) && !PARTICLES.has(word))) return undefined;
  return words.map((word) => word.toLowerCase().replace(/\.$/, "")).find((word) => !TITLES.has(word));
}

/**
 * A name and each word of it that tells it apart, so "Dacre" names Mr Dacre and "Crane" names Crane's cottage, as a phrase
 * matched whole dropped writing that shortened it. A word counts if capitalised, past two letters and not a title.
 */
export const nameForms = (name: string) => [
  name,
  ...name
    .split(" ")
    .map((part) => part.replace(/['’]s$/u, ""))
    .filter((part) => part.length > 2 && /^\p{Lu}/u.test(part) && !TITLES.has(part.toLowerCase().replace(/\.$/, ""))),
];
