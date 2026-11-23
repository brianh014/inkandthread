import { ART_STYLES } from "./art-styles";
import { LONG_TEXT } from "../limits";
import type { Character, HeldPicture, PcDraft, SaveSetup } from "./api";

/** Each description is shown to the player and sent to the Narrator with the theme's name. */
export const THEMES: Record<string, string> = {
  "High Fantasy": "Wondrous realms of magic, ancient kingdoms and epic quests, where good and evil are clearly drawn.",
  "Dark Fantasy": "Grim lands where magic comes at a cost, monsters are real and heroes rarely stay clean.",
  "Urban Fantasy": "Vampires, witches and hidden courts live unseen in the cities of today.",
  Romantasy: "Magic, danger and a love story as central as the quest, in realms where loving the wrong one has a price.",
  Romance: "Two people drawn together, and everything that stands between them, in any age or place.",
  Cyberpunk: "Neon megacities run by corporations, where chrome implants and stolen data are the way to get ahead.",
  "Space Opera": "Starships, galactic empires and mystic powers, in sweeping struggles across the stars.",
  "Sci Fi": "Plausible futures of space travel, advanced technology and first contact.",
  "Modern Day": "The world as it is now, with today's technology, cities and everyday stakes.",
  Steampunk: "A Victorian age of brass, steam and clockwork, with airships, inventors and rigid class lines.",
  "Realistic medieval": "Feudal life shaped by lords, faith, plague and the sword.",
  Western: "The American frontier, with dusty towns, outlaws, lawmen and land worth killing for.",
  "Post-Apocalyptic": "The ruins of a fallen world, where survivors fight over what's left.",
  Horror: "Ordinary lives unravel as something terrible closes in, and safety never lasts.",
  Noir: "Rain-slick streets, crooked cops and secrets that someone will kill to keep.",
  Mystery: "A puzzle to solve, with clues, suspects who all have something to hide, and a truth worth finding out.",
  "Spy Thriller": "Agents, double-crosses and dead drops, where no one is quite who they say and every ally may be selling you out.",
};

export const OWN_THEME = "Create your own";

/** Which theme a Save's text is: a built-in one is stored with its description, so anything else is the player's own. */
export function themeFor(text: string) {
  const name = Object.keys(THEMES).find((theme) => text === `${theme}: ${THEMES[theme]}`);
  return name ? { theme: name, ownTheme: "" } : { theme: OWN_THEME, ownTheme: text };
}

/** `ref` is what the server holds their portrait under, so it stays theirs through a rename or a row removed above. */
export type FormCharacter = Character & { ref: string };

/** On the Cover only when the player says so, as the server puts a character it isn't told about on it. */
export const withCoverChoice = (characters: FormCharacter[]) => characters.map((character) => ({ ...character, onCover: !!character.onCover }));

// Not crypto.randomUUID, which a page reached over the network without HTTPS doesn't have. Only unique within one form.
export const newRef = (length = 8) => Array.from({ length }, () => Math.floor(Math.random() * 36).toString(36)).join("");

export const blank = {
  theme: "High Fantasy",
  ownTheme: "",
  worldBrief: "",
  title: "",
  hookOn: true,
  startingHook: "",
  characters: [] as FormCharacter[],
  artStyle: Object.keys(ART_STYLES)[0]!,
  ownArtStyle: "",
  pc: { name: "", background: "", physicalTraits: "", inventory: "" } as PcDraft,
  /** Whether the Cover shows the PC, as the Important Characters each say for themselves. */
  pcOnCover: true,
  /** What the server holds this form's images and world under, once it holds any. */
  id: undefined as string | undefined,
  /** The player's own few words for each picture's next prompt, such as "smiling". */
  nudges: {} as Record<HeldPicture, string>,
  /** Each picture asked for or uploaded, and how many times it has changed, so that a new image is a new address. */
  drawn: {} as Record<HeldPicture, number>,
  /** The world written from this form. Going back to change the form discards it. */
  world: undefined as { overview: string } | undefined,
};

export type Draft = typeof blank;

export const STORAGE_KEY = "novelforge-new-story";

export const STEPS = [
  { name: "World and Characters", hash: "/new" },
  { name: "Art", hash: "/new/art" },
  { name: "Your World", hash: "/new/overview" },
];

// Kept for the tab, so a reload or a trip to Settings to fix a failure doesn't lose what the player wrote. It only ever holds player-facing text.
// Blocked storage or a damaged value starts a blank form, rather than a blank screen.
const kept = (): Partial<Draft> => {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
};

export const stored = () => {
  const draft = { ...blank, ...kept() };
  // A form kept from before the Important Characters were a list, or had portraits, or from when the PC had more boxes.
  const pc = Object.fromEntries(Object.keys(blank.pc).map((field) => [field, draft.pc[field as keyof PcDraft] ?? ""])) as PcDraft;
  const characters = Array.isArray(draft.characters) ? draft.characters.map((character) => ({ ...character, ref: character.ref ?? newRef() })) : [];
  // A form kept from when pictures went by kind, whose numbers still name the Cover and portrait.
  const drawn = typeof draft.drawn === "object" && draft.drawn ? draft.drawn : {};
  return { ...draft, pc, characters, drawn };
};

export const MAX_CHARACTERS = 10;

export const redrew = (drawn: Draft["drawn"], ...pictures: HeldPicture[]) => ({
  ...drawn,
  ...Object.fromEntries(pictures.map((picture) => [picture, (drawn[picture] ?? 0) + 1])),
});

export const npcPicture = ({ ref }: FormCharacter) => `npcs/${ref}`;

export const characterLabel = (character: FormCharacter, index: number) => character.name.trim() || `Character ${index + 1}`;

// A box's limit stops typing but not a value put in it, and Begin would then fail.
const NAME_CHARS = 80;
const fit = (text: string | undefined, most = LONG_TEXT) => (text ?? "").slice(0, most);

/** Start Over: the form's first step from a Save, and the later steps fresh, so no world or picture carries over. */
export function draftFrom({ worldBrief, title, theme, startingHook, pc, importantCharacters }: SaveSetup): Draft {
  const background = [pc.background, pc.skills, pc.personality, pc.other].filter((part) => part?.trim()).join("\n\n");
  return {
    ...structuredClone(blank),
    ...themeFor(theme),
    worldBrief: fit(worldBrief),
    title: fit(title, NAME_CHARS),
    hookOn: startingHook !== "",
    startingHook: fit(startingHook),
    pc: { name: fit(pc.name, NAME_CHARS), background: fit(background), physicalTraits: fit(pc.physicalTraits), inventory: "" },
    characters: importantCharacters
      .slice(0, MAX_CHARACTERS)
      .map(({ name, description }) => ({ name: fit(name, NAME_CHARS), description: fit(description), ref: newRef(), onCover: false })),
  };
}
