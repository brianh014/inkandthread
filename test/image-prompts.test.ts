import { expect, test } from "bun:test";
import { promptStyle } from "../src/graph-builder";
import { chestUp, expandMarks, markNames } from "../src/image-pipeline";
import { assemblePrompt, IN_ITS_WORLD_AND_STYLE, REQUESTED_IMAGE_PROMPT } from "../src/prompt-assembler";
import { applyOperations, openingState } from "../src/state-applier";

const npcs = [
  { name: "Hesper", appearance: "a tall woman in oilskins" },
  { name: "Orin", appearance: "" },
];
const pc = "Ash Vane";

test("each mark becomes the Narrator's own phrase, beside what they do, and says who is pictured", () => {
  expect(expandMarks("[Hesper: a tall woman in black] waves at [Ash Vane: a short man with a tin badge] on the quay", npcs, pc)).toEqual({
    prompt: "a tall woman in black waves at a short man with a tin badge on the quay",
    pictured: ["Hesper", null],
  });
});

test("a sentence the Narrator repeats goes in once", () => {
  const likeness = "The people are the same people.";
  const looped = `[Hesper: a tall woman] waves. Fog fills the yard. {${likeness}} ${likeness} ${likeness}`;
  expect(expandMarks(looped, npcs, pc, ["Hesper"]).prompt).toBe(`the person from image 1, a tall woman, waves. Fog fills the yard. ${likeness}`);
});

test("anything written after the closing likeness sentence is cut", () => {
  expect(expandMarks("[Hesper: a tall woman] waves. {The people are the same people.} Fill in all fields.", npcs, pc, ["Hesper"]).prompt).toBe(
    "the person from image 1, a tall woman, waves. The people are the same people.",
  );
});

test("JSON written after the likeness sentence is cut", () => {
  const prompt = '[Hesper: a tall woman] waves. {The people are the same people.}\n{"location":"The net loft","visibleCast":["Hesper"]}';
  expect(expandMarks(prompt, npcs, pc, ["Hesper"]).prompt).toBe("the person from image 1, a tall woman, waves. The people are the same people.");
});

test("the PC can be marked by their first name", () => {
  expect(expandMarks("[Ash] sits", npcs, pc).pictured).toEqual([null]);
});

test("a person goes in once, and neither an unknown name nor a missing phrase reaches the model", () => {
  expect(expandMarks("[Hesper: a tall woman] turns, and [Hesper] sighs", npcs, pc)).toEqual({
    prompt: "a tall woman turns, and the same person sighs",
    pictured: ["Hesper"],
  });
  expect(expandMarks("[Tobin] waits", npcs, pc)).toEqual({ prompt: "a person waits", pictured: [] });
  expect(expandMarks("[Orin] waits", npcs, pc)).toEqual({ prompt: "a person waits", pictured: ["Orin"] });
});

test("part of a name finds someone only when it can mean nobody else", () => {
  const people = [
    { name: "Dana Reyes", appearance: "a woman in a grey blazer" },
    { name: "Woman with notebook", appearance: "a woman with a notebook" },
    { name: "Woman with mesh sleeve", appearance: "a woman in mesh" },
  ];
  expect(expandMarks("[Dana: a woman in grey] waits", people, pc)).toEqual({ prompt: "a woman in grey waits", pictured: ["Dana Reyes"] });
  expect(expandMarks("[dana reyes] waits", people, pc).pictured).toEqual(["Dana Reyes"]);
  expect(expandMarks("[Woman] waits", people, pc)).toEqual({ prompt: "a person waits", pictured: [] });
});

test("a person named without a mark is marked, so their portrait goes in and their name never reaches the model", () => {
  const written = "Ash Vane, a short man, waves at Hesper. Hesper's boat bobs. {Keep each face.} Ashore, [Orin: an old man] naps by Orin.";
  const marked = markNames(written, npcs, pc);
  expect(marked).toBe("[Ash Vane], a short man, waves at [Hesper]. Hesper's boat bobs. {Keep each face.} Ashore, [Orin: an old man] naps by [Orin].");
  expect(expandMarks(marked, npcs, pc, [null, "Hesper"]).prompt).toBe(
    "the person from image 1, a short man, waves at the person from image 2. Hesper's boat bobs. Keep each face. Ashore, an old man naps by the same person.",
  );
  expect(markNames("Vane nods", npcs, pc)).toBe("[Vane] nods");
  // An article, a title or a place in someone's name is no name of its own.
  const titled = [
    { name: "The Ferryman", appearance: "" },
    { name: "Mira of Westhold", appearance: "" },
    { name: "Captain Rook", appearance: "" },
  ];
  expect(markNames("The harbour of Westhold, where the Captain waits for Rook and Mira", titled, pc)).toBe(
    "The harbour of Westhold, where the Captain waits for [Rook] and [Mira]",
  );
});

test("no stored looks are ever added, as the Narrator writes the whole prompt to its length", () => {
  expect(expandMarks("[Hesper: a tall woman in black] nods", npcs, pc).prompt).toBe("a tall woman in black nods");
  expect(expandMarks("[Tobin: a thin boy] sits", npcs, pc)).toEqual({ prompt: "a thin boy sits", pictured: [] });
});

test("each person with a portrait is pointed at their image by number, and the likeness sentence stays only then", () => {
  const prompt = "[Hesper: a tall woman] waves at [Ash: a short man] by [Orin: an old man]. {Keep each face.}";
  // The PC's portrait goes first, so Ash is image 1 though marked second, and Orin has no portrait.
  expect(expandMarks(prompt, npcs, pc, [null, "Hesper"]).prompt).toBe(
    "the person from image 2, a tall woman, waves at the person from image 1, a short man, by an old man. Keep each face.",
  );
  expect(expandMarks(prompt, npcs, pc).prompt).toBe("a tall woman waves at a short man by an old man.");
  expect(expandMarks("They wave at [Hesper: a tall woman].", npcs, pc, ["Hesper"]).prompt).toBe("They wave at the person from image 1, a tall woman.");
  // Models sometimes leave off the closing brace at the end.
  expect(expandMarks("[Hesper: a tall woman] waves. {Keep each face.", npcs, pc).prompt).toBe("a tall woman waves.");
  expect(expandMarks("[Hesper: a tall woman] waves. {Keep each face.", npcs, pc, ["Hesper"]).prompt).toBe(
    "the person from image 1, a tall woman, waves. Keep each face.",
  );
});

test.each([
  [{ imageProvider: "local", comfyMode: "simple", comfyFamily: "sd" }, "keywords"],
  [{ imageProvider: "local", comfyMode: "simple", comfyFamily: "flux2" }, "prose"],
  [{ imageProvider: "local", comfyMode: "advanced", comfyFamily: "sd" }, "prose"],
  [{ imageProvider: "openrouter", comfyMode: "simple", comfyFamily: "sd" }, "prose"],
] as const)("%o words its prompts as %s", (settings, style) => {
  expect(promptStyle(settings)).toBe(style);
});

const systemPrompt = (style: Parameters<typeof assemblePrompt>[0]["promptStyle"]) =>
  assemblePrompt({
    save: { worldBrief: "A drowned city", pc: { name: "Ash" }, startingHook: "" },
    state: openingState,
    messages: [],
    modelInstructions: "",
    input: "I look around.",
    responseSchema: "{}",
    promptStyle: style,
  })[0]!.content;

test("the Narrator is asked for a prompt in the Prompt Style, which stands alone and opens with the Art Style", () => {
  const prose = systemPrompt("prose");
  const keywords = systemPrompt("keywords");
  expect(prose).toContain("connected sentences");
  expect(prose).toContain("Mark each person you picture as [Name: phrase]");
  expect(keywords).toContain("comma-separated keyword phrases");
  expect(keywords).not.toContain("[Name: phrase]");
  for (const system of [prose, keywords]) {
    expect(system).toContain("someone who has never read it");
    expect(system).toContain("Open the prompt with the picture's art style");
    expect(system).toContain('"art_style":');
    expect(system).toContain("40 to 60 words");
  }
});

test("with images off the Narrator writes no prompt", () => {
  const system = systemPrompt(null);
  expect(system).toContain("Images are off");
  expect(system).not.toContain("connected sentences");
});

test("the Narrator ends with a likeness sentence in braces, which asks to keep each face but not the portrait's clothing", () => {
  expect(REQUESTED_IMAGE_PROMPT.prose).toContain("end the prompt with one short sentence in curly braces");
  expect(REQUESTED_IMAGE_PROMPT.prose).toContain("the same people with their faces preserved");
});

test("an Image Prompt puts each person once in what they do, keeps props plain and sized, and holds to a real era", () => {
  expect(REQUESTED_IMAGE_PROMPT.prose).toContain("Make each mark the subject of the sentence that says what that person does");
  expect(REQUESTED_IMAGE_PROMPT.prose).toContain("never in a list of who is there");
  expect(REQUESTED_IMAGE_PROMPT.prose).toContain("keep their hands empty otherwise");
  expect(REQUESTED_IMAGE_PROMPT.prose).toContain(
    "Picture only people physically there at this moment, as the narration has it, and at most three, leaving anyone else out of view.",
  );
  expect(REQUESTED_IMAGE_PROMPT.prose).toContain("say plainly where each body is, where each one's arms go and where each head is");
  expect(REQUESTED_IMAGE_PROMPT.prose).toContain("each named plainly with its size, material and place");
  expect(IN_ITS_WORLD_AND_STYLE).toContain("Say which real era and region the place, buildings and clothing resemble");
  expect(IN_ITS_WORLD_AND_STYLE).toContain("in a world set before about 1600, such as an ancient or medieval one, never write coat");
  expect(IN_ITS_WORLD_AND_STYLE).toContain("or for a future or invented world which real styles it borrows from");
});

test("a portrait's template keeps only what a head and shoulders frame shows", () => {
  const seren =
    "a woman in her late twenties, gaunt and hollow-cheeked, with long dark hair, pale bare feet streaked with mud, swallowed in a hooded brown wool cloak, her wrists bound behind her back";
  expect(chestUp(seren)).toBe("a woman in her late twenties, gaunt and hollow-cheeked, with long dark hair, swallowed in a hooded brown wool cloak");
  expect(chestUp("a man with charms on a thong, in those clothes")).toBe("a man with charms on a thong, in those clothes");
});

test("the era is set once, and a later set_era is ignored rather than failing the Turn, so pictures never drift", () => {
  const first = applyOperations(openingState, [{ op: "set_era", era: "early medieval Arabia" }]);
  const again = applyOperations(first.next, [{ op: "set_era", era: "1870s American West" }]);
  expect(again.next.era).toBe("early medieval Arabia");
  expect(again.refused).toEqual([]);
});
