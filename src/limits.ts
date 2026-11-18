/** The most any multiline box on the New Story form may hold, which the form, the server and the Narrator's writing all keep to. */
export const LONG_TEXT = 4000;

export const countWords = (words: string) => words.split(/\s+/).filter(Boolean).length;
// A model is asked for a word limit but refused only half over it, as a limit is guidance and a few words over shouldn't fail a
// whole call: at a quarter, most refused World Moves On rewrites were within half.
export const withinLimit = (words: string, limit: number) => countWords(words) <= Math.ceil(limit * 1.5);
