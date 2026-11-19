import { expect, test } from "bun:test";
import { knownChoices, unknownWords, withoutUnread } from "../src/known-choices";
import { openingState, type State } from "../src/state-applier";

const state: State = {
  ...openingState,
  npcs: [{ name: "Ossery", appearance: "a thin man" }],
  worldBible: [
    { title: "The old hut", keywords: ["old hut", "drums", "Free Wells"], content: "Fuel drums are buried at the old hut.", alwaysOn: false },
    { title: "The road", keywords: ["salt road"], content: "The road.", alwaysOn: true },
  ],
  pcKnown: { facts: ["Jory works the lead strings."], npcs: [] },
};

test("a Choice naming someone or a Lore keyword the player has never read of is caught, and nothing else", () => {
  const choices = ["Ask Tamsin about the old hut.", "Tell Jory that Ossery paid him.", "Ride on and count the drums."];
  // A lone common keyword, such as "drums", is too likely in an honest Choice to count.
  expect(unknownWords(choices, state, "Tamsin rides ahead.")).toEqual([["old hut"], ["Ossery"], []]);
  // Once the player has read of it, it's theirs to ask about.
  expect(unknownWords(choices, state, "Tamsin hears Jory mumble about the old hut and a well-keeper called Ossery.")).toEqual([[], [], []]);
});

test("a Choice naming a place no one has spoken of, or a thing only the secrets hold, is caught, but not a sentence's first word", () => {
  const secret = { ...state, plotThreads: ["Ossery hides the ledger in an oilskin under the well."] };
  const choices = ["Ride for Qasr before dark.", "Search the wagon for an oilskin.", "Tell Tamsin, quietly, what I found."];
  expect(unknownWords(choices, secret, "Tamsin rides ahead. Before dark she searched the wagon.")).toEqual([["Qasr"], ["oilskin"], []]);
});

test("an everyday word the secrets happen to hold isn't taken for something the PC never heard of", () => {
  const secret = { ...state, plotThreads: ["Whatever anyone may examine, the ledger lies hidden in the chimney."] };
  const choices = ["I ask whether anyone saw him.", "I examine whatever is on the desk.", "I check the chimney."];
  expect(unknownWords(choices, secret, "Tamsin rides ahead.")).toEqual([[], [], ["chimney"]]);
});

test("a Choice copying four words in a row from the secrets is caught, unless the player has read them too or they are all everyday words", () => {
  const secret = { ...state, plotThreads: ["Nobody can yet tell whose side the lie falls on, as it is not so simple."] };
  const choices = ["I find out whose side the lie falls on.", "I ask Tamsin whose side she is on.", "I tell her it is not so."];
  expect(unknownWords(choices, secret, "Tamsin rides ahead.")).toEqual([["whose side the lie", "side the lie falls", "the lie falls on"], [], []]);
  // Read by the player too, it's theirs to say.
  expect(unknownWords(choices, secret, "Tamsin asks: whose side does the lie fall on? She wonders whose side the lie falls on.")).toEqual([[], [], []]);
});

test("a day or month is never taken for a made-up name, nor an everyday word the secrets hold for one", () => {
  const secret = { ...state, plotThreads: ["By Sunday the honest clerk has written the ledger out in March."] };
  const choices = ["I wait until Sunday, then go.", "I ask for an honest answer, written down.", "I ride north before March."];
  expect(unknownWords(choices, secret, "Tamsin rides ahead.")).toEqual([[], [], []]);
});

test("a known fact, summary or Loose End naming someone or somewhere the player has only in the secrets is dropped, even if an earlier fact named it", () => {
  const secret = {
    ...state,
    plotThreads: ["Ossery hides the ledger in an oilskin under the well."],
    pcKnown: { facts: ["Ossery wraps it in oilskin."], npcs: [] },
  };
  const operations = [
    { op: "add_known_fact", fact: "Ossery has the ledger." },
    { op: "set_known_npc_summary", name: "Tamsin", summary: "A driver who knows Ossery." },
    // A long word only the secrets hold, as a summary named a woman someone's daughter, which the page never said.
    { op: "add_known_fact", fact: "The ledger is wrapped in oilskin." },
    { op: "add_loose_end", loose_end: "Tamsin wants the ledger found." },
    { op: "npc_learns", name: "Tamsin", fact: "Ossery has the oilskin." },
  ] as Parameters<typeof withoutUnread>[0];
  expect(withoutUnread(operations, secret, "Tamsin rides ahead and speaks of a ledger.")).toEqual(operations.slice(3));
  // Kept once the player has read it.
  expect(withoutUnread(operations, secret, "Tamsin sees the ledger in its oilskin.")).toEqual(operations.slice(2));
});

test("a Journal entry naming a many-word name or keyword is kept when the player has read the word that tells it apart", () => {
  const judge = {
    ...state,
    worldBible: [...state.worldBible, { title: "The judge", keywords: ["Mr Pell", "Pell's court"], content: "", alwaysOn: false }],
  };
  const operations = [
    { op: "add_known_fact", fact: "Mr Pell sits at Pell's court on Tuesday." },
    { op: "add_loose_end", loose_end: "What Ossery saw." },
  ] as Parameters<typeof withoutUnread>[0];
  expect(withoutUnread(operations, judge, "Tamsin says Pell will hear the case.")).toEqual(operations.slice(0, 1));
});

test("a Journal entry naming a Lore Entry by another of its keywords is kept once the player has read one of them", () => {
  const operations = [{ op: "add_known_fact", fact: "Fuel is hidden at Free Wells." }] as Parameters<typeof withoutUnread>[0];
  expect(withoutUnread(operations, state, "Tamsin rides ahead.")).toEqual([]);
  expect(withoutUnread(operations, state, "Tamsin kicks one of the drums.")).toEqual(operations);
});

test("a Choice built on what the PC hasn't learned is dropped, not reworded, and the others are kept", () => {
  // A rewording kept the secret in other words, so no one is asked to write it again.
  const choices = ["Ask Tamsin about the old hut.", "Ask Jory what scares him.", "Ride on."];

  expect(knownChoices(choices, state, "Tamsin rides ahead.", "Jory looks away.")).toEqual(["Ask Jory what scares him.", "Ride on."]);
  expect(knownChoices(["Ask Jory what scares him.", "Ride on.", "Wait."], state, "", "")).toHaveLength(3);
});
