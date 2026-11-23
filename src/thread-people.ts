import { wholeWord } from "./lore-activation";
import { nameForms, type State } from "./state-applier";

/**
 * Who each thread names, for the checks on ending one: each person or place is all the names it goes by, so a thread naming
 * "Thorne" is about "Reverend Amos Thorne". The always-on setting isn't one, or naming the city would tie every thread to it.
 * Its own module, as the Narrator's prompt reads a plan's doer too, and World Moves On already reads that prompt's module.
 */
export function threadPeople(state: Pick<State, "npcs" | "worldBible">) {
  const people = [
    ...state.npcs.map(({ name }) => nameForms(name)),
    ...state.worldBible
      .filter(({ alwaysOn }) => !alwaysOn)
      .map(({ keywords }) => keywords.filter((word) => /^\p{Lu}/u.test(word)).flatMap(nameForms))
      .filter((names) => names.length > 0),
  ];
  const mentions = (text: string, name: string, flags = "iu") => wholeWord(name, flags).test(text);
  const named = (thread: string) => people.filter((names) => names.some((name) => mentions(thread, name, "u")));
  /**
   * Who does a plan: the last person it names before its verb, as "At six Okafor will burn the page" or "After Kit leaves,
   * Thorne will burn it", not a place or someone it touches; the first it names when it has no such verb.
   */
  const doer = (plan: string) => {
    const at = (names: string[]) => Math.min(...names.map((name) => plan.search(wholeWord(name, "u"))).filter((found) => found >= 0));
    const verb = plan.search(/\b(?:will|means|intends|plans|is to)\b/u);
    const byPlace = named(plan)
      .map((names) => ({ names, at: at(names) }))
      .sort((one, other) => one.at - other.at);
    const before = verb < 0 ? [] : byPlace.filter((person) => person.at < verb);
    return (before.at(-1) ?? byPlace[0])?.names;
  };
  /** Whether a plan's doer is among these, as the people with the PC. */
  const doerIn = (plan: string, cast: string[]) => doer(plan)?.some((name) => cast.includes(name)) ?? false;
  return { named, mentions, doer, doerIn };
}
