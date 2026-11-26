/** The most any multiline box on the New Story form may hold, which the form, the server and the Narrator's writing all keep to. */
export const LONG_TEXT = 4000;

export const countWords = (words: string) => words.split(/\s+/).filter(Boolean).length;
// A model is asked for a word limit but refused only half over it, as a limit is guidance and a few words over shouldn't fail a
// whole call: at a quarter, most refused World Moves On rewrites were within half.
export const withinLimit = (words: string, limit: number) => countWords(words) <= Math.ceil(limit * 1.5);

/** The most people a scene picture shows: two by default, as pictures with three or more merged or dropped someone about four times as often. */
export const SCENE_PEOPLE = { least: 1, most: 4, usual: 2 } as const;
