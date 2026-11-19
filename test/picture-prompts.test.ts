import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { settingsStore } from "../src/settings-store";
import { TextProviderFailed } from "../src/turn-engine";
import { coverPrompt } from "../src/image-pipeline";
import { type PictureAsk, reviewScenePrompt, writePicturePrompt } from "../src/world-creation";
import { logOf, png, scriptedImages, scriptedTextProvider, startApp, tempFolder } from "./support";

let folder: ReturnType<typeof tempFolder>;
let app: ReturnType<typeof startApp> | undefined;

beforeEach(() => {
  folder = tempFolder();
});

afterEach(async () => {
  await app?.stop();
  app = undefined;
  folder.remove();
});

const setting = { theme: "High Fantasy", world: "A drowned city", artStyle: "Ink wash: loose black brushwork" };
const cover: PictureAsk = { kind: "cover", title: "The Salt Reckoning", people: ["a tall woman in an oilskin coat"], ...setting };
const portrait: PictureAsk = { kind: "portrait", looks: "a tall woman, wearing an oilskin coat", ...setting };

const write = (ask: PictureAsk, style: "prose" | "keywords", ...replies: (string | Error)[]) => {
  const script = scriptedTextProvider(...replies);
  const settings = settingsStore(join(folder.path, "settings.json"));
  const written = writePicturePrompt({ textProvider: script.textProvider, settings }, ask, style, new AbortController().signal);
  return { written, prompts: script.prompts };
};

const text = (words: string) => JSON.stringify({ text: words });

const SCENE = "[Ash: a short person in grey] kneels by the fire, a cup in each hand. {The people from the images are the same people.}";
const review = (style: "prose" | "keywords", ...replies: (string | Error)[]) => {
  const script = scriptedTextProvider(...replies);
  const settings = settingsStore(join(folder.path, "settings.json"));
  const reviewed = reviewScenePrompt({ textProvider: script.textProvider, settings }, SCENE, style, new AbortController().signal);
  return { reviewed, prompts: script.prompts };
};
const checked = (prompt: string) => JSON.stringify({ prompt });

test("a review sends only the prompt, checks the picture holds together, and its fix is drawn", async () => {
  const fixed = "[Ash: a short person in grey] kneels by the fire, a cup in one hand. {The people from the images are the same people.}";
  const { reviewed, prompts } = review("prose", checked(fixed));

  expect(await reviewed).toBe(fixed);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]![0]!.content).toContain("each hand doing one thing");
  expect(prompts[0]![0]!.content).toContain("Copy every part in square brackets");
  expect(prompts[0]![1]!.content).toBe(JSON.stringify({ prompt: SCENE }));
});

test("a review that changes a mark or the portrait sentence, or runs long, is retried, and then the prompt is drawn as written", async () => {
  const lostMark = checked("[Ash: a tall person in red] kneels by the fire. {The people from the images are the same people.}");
  const lostLikeness = checked("[Ash: a short person in grey] kneels by the fire.");
  const long = checked(`[Ash: a short person in grey] kneels. {The people from the images are the same people.} ${"word ".repeat(400)}`);
  const { reviewed, prompts } = review("prose", lostMark, lostLikeness, long);

  const line = await logOf(() => reviewed, "warning");

  expect(await reviewed).toBe(SCENE);
  expect(prompts).toHaveLength(3);
  expect(line).toContain("drawn unchecked");
  expect(line).not.toContain("fire");
});

test("a review may take out someone who shouldn't be in the picture, and is told never to add a name or writing", async () => {
  const two = "[Ash: a short person in grey] kneels. [Mara: a tall woman] waits. {The people from the images are the same people.}";
  const script = scriptedTextProvider(checked("[Ash: a short person in grey] kneels. {The people from the images are the same people.}"));
  const settings = settingsStore(join(folder.path, "settings.json"));

  const reviewed = await reviewScenePrompt({ textProvider: script.textProvider, settings }, two, "prose", new AbortController().signal);

  expect(reviewed).not.toContain("Mara");
  expect(script.prompts).toHaveLength(1);
  expect(script.prompts[0]![0]!.content).toContain("Never add anyone's name or the name of a place, nor any writing");
});

test("a failed review draws the prompt as written", async () => {
  const { reviewed } = review("keywords", new TextProviderFailed("down"), new TextProviderFailed("down"), new TextProviderFailed("down"));

  expect(await reviewed).toBe(SCENE);
});

test("a Cover's prompt is written whole, Art Style and world included, from only what the player reads, and must letter the title", async () => {
  const { written, prompts } = write(
    cover,
    "prose",
    text("A drowned city at night."),
    text("The Salt Reckoning, a drowned city at night."),
    text(`A drowned city at night, its title "The Salt Reckoning" lettered above.`),
  );

  expect(await written).toBe(`A drowned city at night, its title "The Salt Reckoning" lettered above.`);
  expect(prompts).toHaveLength(3);
  const [system, user] = prompts[0]!;
  expect(system!.content).toContain("front cover of a novel");
  expect(system!.content).toContain("about 170 words and never over 250");
  expect(system!.content).toContain("Never name anyone");
  expect(system!.content).toContain("Open the prompt with the picture's art style");
  expect(system!.content).toContain("as that world and its era have them");
  expect(JSON.parse(user!.content)).toEqual({ title: cover.title, people: cover.people, ...setting });
});

test.each([
  ["prose", 120],
  ["keywords", 60],
] as const)("a %s portrait's prompt keeps to %i words, retrying one half over", async (style, words) => {
  const { written, prompts } = write(portrait, style, text("tall ".repeat(Math.ceil(words * 1.5) + 1)), text("A tall woman in an oilskin coat."));

  expect(await written).toBe("A tall woman in an oilskin coat.");
  expect(prompts[0]![0]!.content).toContain(`about ${Math.round(words * 0.75)} words and never over ${words}`);
  expect(prompts[0]![0]!.content).toContain(style === "keywords" ? "comma-separated keyword phrases" : "connected sentences");
});

test("a prompt the text model can't write fails with a reason to show, and nothing is drawn from a template", async () => {
  const failed = new TextProviderFailed("offline");
  const { written } = write(portrait, "prose", failed, failed, failed);

  expect(written).rejects.toThrow("The text model couldn't write this picture's prompt. Try again.");
});

test("the server draws a form's portrait from the written prompt, and shows that prompt for a Redraw", async () => {
  const script = scriptedTextProvider(text("A tall woman in an oilskin coat, facing the viewer."));
  const drawn = scriptedImages(png(1));
  const settings = settingsStore(join(folder.path, "settings.json"));
  app = startApp(join(folder.path, "Saves"), script.textProvider, undefined, undefined, drawn.imageAdapter, (ask, style, _template, signal) =>
    writePicturePrompt({ textProvider: script.textProvider, settings }, ask, style, signal),
  );
  await app.patch("/settings", { imageModel: "fake/image", imageApiKey: "image-key" });

  const response = await app.post("/worlds/draw", { kind: "portrait", name: "Ash", physicalTraits: "Tall", inventory: "an oilskin coat", artStyle: "" });
  const { id } = (await response.json()) as { id: string };
  const details = (await (await app.get(`/worlds/${id}/portrait/details`)).json()) as { prompt: string };

  expect(drawn.payloads[0]!.prompt).toBe("A tall woman in an oilskin coat, facing the viewer.");
  expect(details.prompt).toBe("A tall woman in an oilskin coat, facing the viewer.");
  expect(script.prompts[0]![1]!.content).not.toContain("Ash");
});

test("a Cover's title may be lettered in capitals", async () => {
  const { written, prompts } = write(cover, "prose", text(`A drowned city, "THE SALT RECKONING" lettered above.`));

  expect(await written).toBe(`A drowned city, "THE SALT RECKONING" lettered above.`);
  expect(prompts).toHaveLength(1);
});

test("a Cover's template takes only the opening of a long world and of each person", () => {
  const long = coverPrompt({
    title: "The Salt Reckoning",
    theme: "Western",
    world: `Rain never stops. ${"word ".repeat(500)}`,
    people: [
      `Tall.

${"more ".repeat(500)}`,
    ],
  });

  expect(long).toContain("Rain never stops.");
  expect(long).toContain("(Tall. more");
  expect(long.split(/\s+/).length).toBeLessThan(300);
});

test("a nudge is the player's request for that picture, which the prompt must show", async () => {
  const { written, prompts } = write({ ...portrait, nudge: "smiling" }, "prose", text("A tall woman, smiling."));

  expect(await written).toBe("A tall woman, smiling.");
  expect(prompts[0]![0]!.content).toContain("nudge is the player's own request for this picture");
  expect(JSON.parse(prompts[0]![1]!.content)).toMatchObject({ nudge: "smiling" });
  const plain = write(portrait, "prose", text("A tall woman."));
  await plain.written;
  expect(plain.prompts[0]![0]!.content).not.toContain("nudge");
});

test("an Update's portrait prompt is a short edit of the old portrait: the same face, then how they look now", async () => {
  const reply = JSON.stringify({
    keep: "The same woman with her face preserved.",
    changes: "She is wearing an oilskin coat. Standing in front of a plain neutral background.",
  });
  const { written, prompts } = write({ ...portrait, was: "A tall woman in a green shirt." }, "prose", reply);

  // The person first, as the text model ignored the order it was given, and the Art Style last, as an edit without it came out a photograph.
  expect(await written).toBe(
    "The same woman with her face preserved. She is wearing an oilskin coat. Standing in front of a plain neutral background. Ink wash: loose black brushwork",
  );
  const system = prompts[0]![0]!.content;
  expect(system).toContain("The image model is given the portrait that was describes, and edits it.");
  expect(system).toContain("the same person with their face preserved");
  expect(system).toContain("Never describe their face's features");
  expect(system).toContain("Only when nudge asks for an expression, start changes with it as a mild one");
  expect(system).toContain("a last sentence placing them in front of a plain neutral background");
  expect(system).not.toContain("Open the prompt with the picture's art style");
  expect(system).not.toContain("never what isn't");
  expect(JSON.parse(prompts[0]![1]!.content)).toMatchObject({ was: "A tall woman in a green shirt.", looks: portrait.looks });
  const whole = write(portrait, "prose", text("A tall woman."));
  await whole.written;
  expect(whole.prompts[0]![0]!.content).not.toContain("edits it");
});

test("a Cover or portrait follows the Image Instructions, and never the Model Instructions", async () => {
  const script = scriptedTextProvider(text("A tall woman in soft light."));
  const settings = settingsStore(join(folder.path, "settings.json"));
  settings.update({ modelInstructions: "model-words", imageInstructions: "image-words" });

  await writePicturePrompt({ textProvider: script.textProvider, settings }, portrait, "prose", new AbortController().signal);

  const sent = JSON.stringify(script.prompts[0]);
  expect(sent).toContain("image-words");
  expect(sent).not.toContain("model-words");
});

test("a portrait drawn from an older one's face, with no prompt to edit, is written to say the face is all it takes", async () => {
  const { written, prompts } = write({ ...portrait, face: true }, "prose", text("A tall woman. The older portrait shows only her face and hair."));
  await written;

  expect(prompts[0]![0]!.content).toContain("given an older portrait of this person");
  expect(JSON.parse(prompts[0]![1]!.content)).not.toHaveProperty("face");
  const plain = write(portrait, "prose", text("A tall woman."));
  await plain.written;
  expect(plain.prompts[0]![0]!.content).not.toContain("older portrait");
});
