import { expect, test } from "bun:test";
import { activateLore } from "../src/lore-activation";
import { assemblePrompt } from "../src/prompt-assembler";
import { applyOperations, MAX_NPC_KNOWS, MAX_PLOT_THREADS, openingState, type LoreEntry, type State, type StateOperation } from "../src/state-applier";

const entry = (title: string, keywords: string[], extra: Partial<LoreEntry> = {}): LoreEntry => ({
  title,
  keywords,
  content: `${title} text`,
  alwaysOn: false,
  ...extra,
});
const withState = (sections: Partial<State>) => ({ ...structuredClone(openingState), ...sections });
const run = (state: State, ...operations: StateOperation[]) => {
  const { next, refused } = applyOperations(state, operations);
  expect(refused).toEqual([]);
  return next;
};

test("when Lore won't all fit, the entry named most recently goes first, wherever it sits in the World Bible", () => {
  const entries = [entry("Early", ["harbour"]), entry("Late", ["Nadia"])];
  const cost = Math.ceil("Late\nLate text".length / 4);

  const active = activateLore(entries, "The harbour. Later, Nadia speaks.", cost);

  expect(active.map(({ title }) => title)).toEqual(["Late"]);
});

test("a keyword's latest mention counts, not its first", () => {
  const entries = [entry("Early", ["harbour"]), entry("Late", ["Nadia"])];
  const cost = Math.ceil("Early\nEarly text".length / 4);

  const active = activateLore(entries, "Nadia speaks. Later, the harbour.", cost);

  expect(active.map(({ title }) => title)).toEqual(["Early"]);
});

test("a Lore Entry can be rewritten, by the Narrator, and stays keyword-activated", () => {
  const state = withState({ worldBible: [entry("Ellis", ["Ellis"])] });

  const next = run(state, { op: "update_lore_entry", title: "Ellis", keywords: ["Ellis", "Crane"], content: "Ellis died in April." });

  expect(next.worldBible).toEqual([{ title: "Ellis", keywords: ["Ellis", "Crane"], content: "Ellis died in April.", alwaysOn: false }]);
});

test("rewriting a Lore Entry that isn't there adds it, and removing one that isn't there changes nothing, so neither costs the Turn", () => {
  const rewrite: StateOperation = { op: "update_lore_entry", title: "New", keywords: ["new"], content: "Fresh." };

  expect(run(withState({}), rewrite).worldBible).toEqual([{ title: "New", keywords: ["new"], content: "Fresh.", alwaysOn: false }]);
  expect(run(withState({}), { op: "remove_lore_entry", title: "Gone" }).worldBible).toEqual([]);
});

test("the Narrator can remove a Lore Entry, but neither rewrite nor remove an always-on one", () => {
  const pinned = entry("Canon", ["canon"], { alwaysOn: true });
  const state = withState({ worldBible: [pinned, entry("Stale", ["stale"])] });

  const next = run(
    state,
    { op: "remove_lore_entry", title: "Stale" },
    { op: "update_lore_entry", title: "Canon", keywords: ["other"], content: "Changed." },
    { op: "remove_lore_entry", title: "Canon" },
  );

  expect(next.worldBible).toEqual([pinned]);
});

for (const [name, list, operation] of [
  ["Plot Thread", "plotThreads", (from: string, replacement: string) => ({ op: "update_plot_thread", thread: from, replacement })],
  ["known fact", "facts", (from: string, replacement: string) => ({ op: "update_known_fact", fact: from, replacement })],
] as const) {
  const stateWith = (...items: string[]) => (list === "facts" ? withState({ pcKnown: { facts: items, npcs: [] } }) : withState({ plotThreads: items }));
  const itemsOf = (state: State) => (list === "facts" ? state.pcKnown.facts : state.plotThreads);
  const rewrite = (state: State, from: string, to: string) => itemsOf(run(state, operation(from, to) as StateOperation));

  test(`a ${name} is rewritten where it stands`, () => {
    expect(rewrite(stateWith("a", "b", "c"), "b", "B")).toEqual(["a", "B", "c"]);
  });

  test(`rewriting a ${name} that isn't there adds the new one, so a miscopied one doesn't cost the Turn`, () => {
    expect(rewrite(stateWith("a"), "a with a typo", "B")).toEqual(["a", "B"]);
  });

  test(`two versions of a ${name} merge into one`, () => {
    expect(rewrite(stateWith("a", "b"), "a", "b")).toEqual(["b"]);
  });

  test(`rewriting a ${name} to itself keeps it`, () => {
    expect(rewrite(stateWith("a"), "a", "a")).toEqual(["a"]);
  });
}

test("a full list of Plot Threads takes no new one, by add or by a miscopied rewrite, but still takes an exact rewrite, and costs no Turn", () => {
  const full = withState({ plotThreads: Array.from({ length: MAX_PLOT_THREADS }, (_, i) => `t${i}`) });

  const { next, refused } = applyOperations(full, [
    { op: "add_plot_thread", thread: "new" },
    { op: "update_plot_thread", thread: "miscopied", replacement: "new" },
    { op: "update_plot_thread", thread: "t0", replacement: "T0" },
  ]);

  expect(refused).toEqual([]);
  expect(next.plotThreads).toEqual(["T0", ...full.plotThreads.slice(1)]);
});

const THREADS = [
  "The smugglers of Greyport are moving stolen relics through the old lighthouse at night.",
  "Captain Rhys of Greyport owes a debt to the Guild and will betray anyone to settle it.",
  "A plague ship drifts toward the harbour, and nobody aboard has been seen alive.",
];
const fullOf = (...threads: string[]) => [...threads, ...Array.from({ length: MAX_PLOT_THREADS - threads.length }, (_, i) => `Filler thread number ${i}.`)];

test("a miscopied Plot Thread is matched to the closest one, so a full list still takes its rewrite", () => {
  const state = withState({ plotThreads: fullOf(...THREADS) });

  const next = run(state, {
    op: "update_plot_thread",
    thread: "Smugglers in Greyport move stolen relics through the old lighthouse by night.",
    replacement: "The lighthouse is watched now.",
  });

  expect(next.plotThreads).toEqual(fullOf("The lighthouse is watched now.", ...THREADS.slice(1)));
});

test("a miscopied Plot Thread can be resolved", () => {
  const state = withState({ plotThreads: [...THREADS] });

  expect(run(state, { op: "resolve_plot_thread", thread: "A plague ship drifts toward the harbor; no one aboard is seen alive." }).plotThreads).toEqual(
    THREADS.slice(0, 2),
  );
});

test("a thread sharing only a name with one in the list, or matching two equally, is no match", () => {
  const state = withState({ plotThreads: fullOf(...THREADS, "Greyport smugglers fear the lighthouse.", "Greyport smugglers fear the Guild.") });
  const { next, ignored } = applyOperations(state, [
    { op: "update_plot_thread", thread: "Greyport elects a new mayor.", replacement: "x" },
    { op: "update_plot_thread", thread: "Greyport smugglers fear.", replacement: "y" },
  ]);

  expect(ignored).toEqual([
    { op: "update_plot_thread", reason: "full" },
    { op: "update_plot_thread", reason: "full" },
  ]);
  expect(next.plotThreads).toEqual(state.plotThreads);
});

test("a new Plot Thread sent before the resolve that makes room for it is still kept", () => {
  const state = withState({ plotThreads: fullOf(...THREADS) });

  const next = run(state, { op: "add_plot_thread", thread: "New." }, { op: "resolve_plot_thread", thread: THREADS[2]! });

  expect(next.plotThreads).toEqual([...fullOf(...THREADS).filter((thread) => thread !== THREADS[2]), "New."]);
});

test("a Plot Thread this reply already resolved or rewrote is never matched to another that shares its words", () => {
  const twins = ["Greyport smugglers fear the lighthouse keeper.", "Greyport smugglers fear the lighthouse keeper's daughter."];
  const state = withState({ plotThreads: [...twins] });

  const next = run(
    state,
    { op: "resolve_plot_thread", thread: twins[0]! },
    { op: "resolve_plot_thread", thread: "Greyport smugglers fear the lighthouse keeper" },
  );

  expect(next.plotThreads).toEqual(twins.slice(1));
});

test("at a full list, a rewrite of a thread the reply is still waiting to add waits for it, and touches no other", () => {
  const state = withState({ plotThreads: fullOf(...THREADS) });

  const next = run(
    state,
    { op: "add_plot_thread", thread: "Captain Rhys of Greyport flees the Guild." },
    { op: "resolve_plot_thread", thread: THREADS[2]! },
    { op: "update_plot_thread", thread: "Captain Rhys of Greyport flees the Guild.", replacement: "Rhys is caught." },
  );

  expect(next.plotThreads).toEqual([...THREADS.slice(0, 2), ...fullOf(...THREADS).slice(3), "Rhys is caught."]);
});

test("resolving a thread by its old words after rewriting it in the same reply resolves the rewrite", () => {
  const next = run(
    withState({ plotThreads: [...THREADS] }),
    { op: "update_plot_thread", thread: THREADS[0]!, replacement: "The lighthouse is watched now." },
    { op: "resolve_plot_thread", thread: THREADS[0]! },
  );

  expect(next.plotThreads).toEqual(THREADS.slice(1));
});

test("rewriting a thread this reply already resolved doesn't bring it back", () => {
  const next = run(
    withState({ plotThreads: [...THREADS] }),
    { op: "resolve_plot_thread", thread: THREADS[0]! },
    { op: "update_plot_thread", thread: THREADS[0]!, replacement: "The lighthouse is watched now." },
  );

  expect(next.plotThreads).toEqual(THREADS.slice(1));
});

test("at a full list, adding a thread that's already open doesn't stop it being resolved", () => {
  const { next } = applyOperations(withState({ plotThreads: fullOf(...THREADS) }), [
    { op: "add_plot_thread", thread: THREADS[0]! },
    { op: "resolve_plot_thread", thread: THREADS[0]! },
  ]);

  expect(next.plotThreads).not.toContain(THREADS[0]);
});

test("a thread rewritten and rewritten back still matches a paraphrase", () => {
  const next = run(
    withState({ plotThreads: [...THREADS] }),
    { op: "update_plot_thread", thread: THREADS[2]!, replacement: "Gone quiet." },
    { op: "update_plot_thread", thread: "Gone quiet.", replacement: THREADS[2]! },
    { op: "resolve_plot_thread", thread: "A plague ship drifts toward the harbor; no one aboard is seen alive." },
  );

  expect(next.plotThreads).toEqual(THREADS.slice(0, 2));
});

test("a miscopied Plot Thread is matched only among those the Narrator was shown", () => {
  const hidden = "Smugglers in Greyport move stolen relics through the old lighthouse by night.";
  const state = withState({ plotThreads: [...fullOf(...THREADS), hidden] });

  const next = run(state, { op: "update_plot_thread", thread: hidden.replace("by night", "at night"), replacement: "Watched." });

  expect(next.plotThreads[0]).toBe("Watched.");
  expect(next.plotThreads.at(-1)).toBe(hidden);
});

test("a Plot Thread added and then rewritten in one reply ends up rewritten", () => {
  expect(run(withState({}), { op: "add_plot_thread", thread: "A" }, { op: "update_plot_thread", thread: "A", replacement: "B" }).plotThreads).toEqual(["B"]);
});

test("a known fact can be removed, and removing one that isn't there changes nothing", () => {
  const state = withState({ pcKnown: { facts: ["a", "b"], npcs: [] } });

  expect(run(state, { op: "remove_known_fact", fact: "a" }, { op: "remove_known_fact", fact: "not there" }).pcKnown.facts).toEqual(["b"]);
});

const twoPeople = () =>
  withState({
    npcs: [
      { name: "Woman with notebook", appearance: "old looks" },
      { name: "Nadia", appearance: "kept looks" },
    ],
    scene: { location: "A room", visibleCast: ["Woman with notebook"] },
    pcKnown: { facts: [], npcs: ["Woman with notebook", "Nadia"], summaries: { "Woman with notebook": "old summary", Nadia: "kept summary" } },
  });
const merge: StateOperation = { op: "merge_npc", name: "Woman with notebook", into: "Nadia" };

test("merging two NPCs leaves one person everywhere the state names them, with the kept one's looks and summary", () => {
  const next = run(twoPeople(), merge);

  expect(next.npcs).toEqual([{ name: "Nadia", appearance: "kept looks" }]);
  expect(next.pcKnown.npcs).toEqual(["Nadia"]);
  expect(next.pcKnown.summaries).toEqual({ Nadia: "kept summary" });
  expect(next.scene.visibleCast).toEqual(["Nadia"]);
});

test("the kept NPC takes the other's place where it has none of its own", () => {
  const state = twoPeople();
  state.pcKnown = { facts: [], npcs: ["Woman with notebook"], summaries: { "Woman with notebook": "old summary" } };

  const next = run(state, merge);

  expect(next.pcKnown.npcs).toEqual(["Nadia"]);
  expect(next.pcKnown.summaries).toEqual({ Nadia: "old summary" });
});

test("merging into a name the state doesn't have renames the NPC", () => {
  const next = run(twoPeople(), { op: "merge_npc", name: "Woman with notebook", into: "Nadia Bell" });

  expect(next.npcs.map(({ name }) => name)).toEqual(["Nadia Bell", "Nadia"]);
  expect(next.npcs[0]!.appearance).toBe("old looks");
  expect(next.pcKnown.npcs).toEqual(["Nadia Bell", "Nadia"]);
});

test("a merge of someone not in the state, or of someone into themselves, changes nothing and doesn't cost the Turn", () => {
  expect(run(twoPeople(), { op: "merge_npc", name: "Nobody", into: "Nadia" })).toEqual(twoPeople());
  expect(run(twoPeople(), { op: "merge_npc", name: "Nadia", into: "Nadia" })).toEqual(twoPeople());
});

test("an NPC keeps what they learn, once each and only the newest few, and a merge joins both lists", () => {
  const learns = (name: string, fact: string): StateOperation => ({ op: "npc_learns", name, fact });
  const facts = Array.from({ length: MAX_NPC_KNOWS + 1 }, (_, i) => `Fact ${String.fromCharCode(97 + i)}`);

  const next = run(twoPeople(), ...facts.map((fact) => learns("Nadia", fact)), learns("Nadia", "Fact b"), learns("Woman with notebook", "Saw the fire"));

  expect(next.npcKnows.Nadia).toEqual(facts.slice(1));
  // The kept one's own are the newest, so the other's go first when the list is full.
  expect(run(next, merge).npcKnows).toEqual({ Nadia: facts.slice(1) });
  expect(run(next, { op: "merge_npc", name: "Nadia", into: "Woman with notebook" }).npcKnows["Woman with notebook"]).toEqual([
    ...facts.slice(2),
    "Saw the fire",
  ]);
});

test("npc_learns for someone not in the state, or with no words, changes nothing and doesn't cost the Turn", () => {
  const { next, refused, ignored } = applyOperations(twoPeople(), [
    { op: "npc_learns", name: "Nobody", fact: "A secret" },
    { op: "npc_learns", name: "Nadia", fact: ", ." },
  ]);

  expect(next).toEqual(twoPeople());
  expect(refused).toEqual([]);
  expect(ignored).toHaveLength(2);
});

test("a merge keeps a fact both knew among the kept one's own, so the cap can't drop it first", () => {
  const state = twoPeople();
  const own = Array.from({ length: MAX_NPC_KNOWS }, (_, i) => `Own ${i}`);
  state.npcKnows = { "Woman with notebook": ["Shared", "Other's"], Nadia: ["Shared", ...own.slice(1)] };

  expect(run(state, merge).npcKnows.Nadia).toEqual(["Shared", ...own.slice(1)]);
});

test("an NPC named like something every object has learns as anyone else does", () => {
  const state = withState({ npcs: [{ name: "constructor", appearance: "looks" }] });

  expect(run(state, { op: "npc_learns", name: "constructor", fact: "Saw the fire" }).npcKnows).toEqual({ constructor: ["Saw the fire"] });
});

test("npc_learns by part of a name reaches the one NPC it can mean", () => {
  const state = withState({ npcs: [{ name: "Nadia Petrova", appearance: "looks" }] });

  expect(run(state, { op: "npc_learns", name: "Nadia", fact: "Saw the fire" }).npcKnows).toEqual({ "Nadia Petrova": ["Saw the fire"] });
});

test("the Narrator sees what people know only for those in the scene or named by the player or the last reply", () => {
  const people = ["Woman with notebook", "Nadia Petrova", "Jean-Luc O'Brien", "Will Ash", "The Ferryman", "The Old Man", "Al", "Arriving", "Other"];
  const state = withState({
    npcs: people.map((name) => ({ name, appearance: "looks" })),
    scene: { location: "A room", visibleCast: ["Woman with notebook"] },
    npcKnows: Object.fromEntries(people.map((name) => [name, [`KNOWS-${name.toUpperCase()}.`]])),
  });

  const prompt = textOfPrompt(
    assemblePrompt({
      save: { worldBrief: "", pc: { name: "Ash" }, startingHook: "" } as never,
      state,
      messages: [
        { id: 1, role: "player", text: "I wait." },
        { id: 2, role: "narrator", text: "Arriving steps in." },
      ],
      modelInstructions: "",
      input: "Alright, I call for Nadia and the ferryman, and ask Jean-Luc what we will do.",
      responseSchema: "{}",
      promptStyle: null,
    }),
  );

  for (const name of ["Woman with notebook", "Nadia Petrova", "Jean-Luc O'Brien", "The Ferryman", "Arriving"])
    expect(prompt).toContain(`KNOWS-${name.toUpperCase()}.`);
  // "will" isn't Will, "Al" isn't in "Alright", and "the" alone isn't The Old Man.
  for (const name of ["Will Ash", "The Old Man", "Al", "Other"]) expect(prompt).not.toContain(`KNOWS-${name.toUpperCase()}.`);
});

const textOfPrompt = (prompt: { content: string }[]) => prompt.map(({ content }) => content).join("\n");

const promptFor = (sections: Partial<State> = {}, input = "I wait.") => {
  const prompt = assemblePrompt({
    save: { worldBrief: "", pc: { name: "Ash" }, startingHook: "" } as never,
    state: withState(sections),
    messages: [],
    modelInstructions: "",
    input,
    responseSchema: "{}",
    promptStyle: null,
  });
  return prompt.map(({ content }) => content).join("\n");
};

test("a Save holding more Plot Threads than the limit sends only the first ones", () => {
  const prompt = promptFor({ plotThreads: Array.from({ length: MAX_PLOT_THREADS + 1 }, (_, i) => `THREAD-${i}.`) });

  expect(prompt).toContain(`THREAD-${MAX_PLOT_THREADS - 1}.`);
  expect(prompt).not.toContain(`THREAD-${MAX_PLOT_THREADS}.`);
});

test("the Narrator is told beside the Plot Threads when they're full, and only then", () => {
  const full = "Plot Threads (8 of 8 open, so resolve or rewrite one before adding another):";

  expect(promptFor({ plotThreads: Array.from({ length: MAX_PLOT_THREADS }, (_, i) => `T${i}.`) })).toContain(full);
  expect(promptFor({ plotThreads: ["T."] })).toContain('Plot Threads: ["T."]');
});

test("the Narrator is told to keep its records true to play", () => {
  const prompt = promptFor();

  expect(prompt).toContain("what has happened in play beats any Lore Entry or Plot Thread");
  for (const op of ["update_lore_entry", "remove_lore_entry", "update_plot_thread", "update_known_fact", "remove_known_fact", "merge_npc"])
    expect(prompt).toContain(op);
});

test("the summary has room to keep what still matters, most of it for the recent story", () => {
  expect(promptFor()).toContain("under 500 words");
  expect(promptFor()).toContain("give the last few scenes about two thirds of the words");
});

test("the last instruction asks for fresh prose, natural speech and none of the player's words back", () => {
  const prompt = promptFor();

  expect(prompt.indexOf("Keep the prose fresh")).toBeGreaterThan(prompt.indexOf("world_rules:"));
  expect(prompt).toContain("contractions");
  expect(prompt).toContain("never on a background sound or passing detail");
  expect(prompt).toContain("Never repeat the player's words back");
});

test("the last instruction has the Narrator correct a wrong assumption, in play and keeping its secrets", () => {
  const prompt = promptFor();
  const rule = prompt.indexOf("assume something that isn't so");

  expect(rule).toBeGreaterThan(prompt.indexOf("world_rules:"));
  expect(prompt.slice(rule)).toContain("make what is true clear in this reply");
  expect(prompt.slice(rule)).toContain("keeping every secret");
});

test("a long story's World Bible fits the budget, with its Plot Threads and world_rules", () => {
  // The size of a story with 140 replies behind it: 20 entries of about 225 tokens, with 750 tokens of threads and rules.
  const worldBible = Array.from({ length: 20 }, (_, index) => entry(`Entry ${index}`, ["city"], { content: "x".repeat(900) }));

  const prompt = promptFor({ worldBible, plotThreads: ["t".repeat(2000)], worldRules: ["r".repeat(1000)] }, "I walk through the city.");

  for (const { title } of worldBible) expect(prompt).toContain(`"${title}"`);
});
