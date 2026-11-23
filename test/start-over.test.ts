import { expect, test } from "bun:test";
import { LONG_TEXT } from "../src/limits";
import { OWN_TONE, TONES, toneFor, toneText, WORLDS_OWN } from "../src/tones";
import { blank, draftFrom, OWN_THEME, THEMES, themeFor } from "../src/web/wizard-draft";

const setup = (fields: Partial<Parameters<typeof draftFrom>[0]> = {}): Parameters<typeof draftFrom>[0] => ({
  worldBrief: "A drowned city",
  title: "Tides",
  theme: `Noir: ${THEMES.Noir}`,
  tone: "",
  startingHook: "",
  pc: { name: "Ash", background: "A diver.", physicalTraits: "Tall." },
  importantCharacters: [{ name: "Mara", description: "A smuggler." }],
  ...fields,
});

test("a built-in theme comes back as itself, and anything else as the player's own", () => {
  expect(themeFor(`Noir: ${THEMES.Noir}`)).toEqual({ theme: "Noir", ownTheme: "" });
  expect(themeFor(`Romantasy: ${THEMES.Romantasy}`)).toEqual({ theme: "Romantasy", ownTheme: "" });
  expect(themeFor("Noir")).toEqual({ theme: OWN_THEME, ownTheme: "Noir" });
  expect(themeFor("Sunken kingdoms")).toEqual({ theme: OWN_THEME, ownTheme: "Sunken kingdoms" });
  expect(themeFor("")).toEqual({ theme: OWN_THEME, ownTheme: "" });
});

test("a Tone comes back as its pick, a player's own as their words, and none as the world's own", () => {
  for (const [tone, ownTone] of [
    ["Wry", ""],
    [OWN_TONE, "Like a fireside tale"],
    [WORLDS_OWN, ""],
  ] as const) {
    expect(toneFor(toneText(tone, ownTone))).toEqual({ tone, ownTone });
  }
  expect(toneText("Grim", "")).toBe(`Grim: ${TONES.Grim}`);
  // An empty own Tone is none.
  expect(toneText(OWN_TONE, "  ")).toBe("");
  expect(draftFrom(setup({ tone: `Wry: ${TONES.Wry}` }))).toMatchObject({ tone: "Wry", ownTone: "" });
});

test("Start Over fills only the first step, with no world or pictures", () => {
  const draft = draftFrom(setup());

  expect(draft).toMatchObject({
    theme: "Noir",
    worldBrief: "A drowned city",
    title: "Tides",
    hookOn: false,
    startingHook: "",
    pc: { name: "Ash", background: "A diver.", physicalTraits: "Tall.", inventory: "" },
    artStyle: blank.artStyle,
    pcOnCover: blank.pcOnCover,
    id: undefined,
    world: undefined,
    drawn: {},
    nudges: {},
  });
  expect(draft.characters).toEqual([{ name: "Mara", description: "A smuggler.", ref: expect.any(String), onCover: false }]);
});

test("a Starting Hook is kept on, and an older PC's other fields join the background, cut to what the form takes", () => {
  const draft = draftFrom(
    setup({ startingHook: "A knock at night.", pc: { name: "Ash", background: "A diver.", skills: "Swims.", personality: "x".repeat(LONG_TEXT) } }),
  );

  expect(draft).toMatchObject({ hookOn: true, startingHook: "A knock at night." });
  expect(draft.pc.background.startsWith("A diver.\n\nSwims.\n\nx")).toBe(true);
  expect(draft.pc.background).toHaveLength(LONG_TEXT);
});
