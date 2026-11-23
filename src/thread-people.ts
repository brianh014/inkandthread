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
    // Each person by the longest of their names the plan holds, and none whose words lie inside another's longer name, as
    // "Vell" in "Jon Vell" is not Mara Vell.
    const found = named(plan).map((names) => {
      const [name] = names.filter((form) => mentions(plan, form, "u")).toSorted((one, other) => other.length - one.length);
      const at = plan.search(wholeWord(name!, "u"));
      return { names, at, end: at + name!.length };
    });
    const inside = (person: (typeof found)[number]) =>
      found.some((other) => other !== person && other.at <= person.at && person.end <= other.end && other.end - other.at > person.end - person.at);
    const verb = plan.search(/\b(?:will|means|intends|plans|is to)\b/u);
    const byPlace = found.filter((person) => !inside(person)).sort((one, other) => one.at - other.at);
    // No one named before its verb is someone not yet known, as "the smugglers will drag Kit off", never the one it touches.
    if (verb >= 0) return byPlace.filter((person) => person.at < verb).at(-1)?.names;
    return byPlace[0]?.names;
  };
  /** Whether a plan's doer is among these, as the people with the PC. */
  const doerIn = (plan: string, cast: string[]) => {
    const names = doer(plan);
    // By a full name, as a character's Lore Entry, holding their full name, outranked their own entry; never by a shared
    // surname alone, as "Jon Vell" is not "Mara Vell".
    const full = names?.toSorted((one, other) => other.length - one.length)[0];
    return !!names && cast.some((person) => names.includes(person) || nameForms(person).includes(full!));
  };
  return { named, mentions, doer, doerIn };
}
