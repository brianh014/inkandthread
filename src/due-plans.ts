// A hidden plan whose hour comes while the PC is near. Code knows each plan's hour and the Narrator only its words, so of 23 plans
// that came due in a bench play 4 reached the page, and the next move of the world told the rest as done out of sight, some at
// the PC's own camp.
import { common } from "./known-choices";
import { wholeWord } from "./lore-activation";
import { clockOf, nameForms, type State } from "./state-applier";
import { threadPeople } from "./thread-people";
import { deedWords, echoes } from "./world-moves-on";

/** Story hours a reply is taken to pass at the least, as at a pace of 0.05 a plan's hour fell inside a reply that took 0.2. */
const USUAL_PACE = 0.1;
/** The furthest ahead of its hour a plan is brought on, as a pace of travel is no pace for talk. */
const NEAR_HOURS = 0.5;
/** Added to the reach, as 43.75 and 0.05 came to a hair under the 43.8 a plan was due. */
const ROUNDING = 0.01;
/** The most replies one plan is offered to, so one the Narrator leaves out goes to the next move of the world. */
const MOST_OFFERS = 2;
// The words of a place that tell nothing of which, as "carries the lie north" put a far well at a north rock.
const ANY_PLACE = new Set(
  "north south east west upper lower above below between near inside outside behind under over house hall road street door hers their mouth edge side".split(
    " ",
  ),
);

/** How many committed Turns each Save's plans were offered to. shortcut: in memory, so a restart offers a plan afresh; store it if one is played twice. */
const offered = new Map<string, Map<string, number>>();
export const planOffered = (id: string, plan: string) => {
  const times = offered.get(id) ?? new Map<string, number>();
  offered.set(id, times.set(plan, (times.get(plan) ?? 0) + 1));
};
/** A Revert takes the replies a plan was offered to. */
export const forgetOffers = (id: string) => offered.delete(id);

const TITLE = /^(?:Mr|Mrs|Miss|Ms|Dr|Doctor|Captain|Constable|Reverend|Sergeant|Lord|Lady|Sir|Old|Young|The|At|By|When|Then|And|Before|After)$/;
/** Whether a plan names this person, by their whole name or a part that is no one else's, as "Jon Vell" is not Mara Vell. */
const names = (plan: string, person: string) =>
  wholeWord(person, "u").test(plan) ||
  nameForms(person).some((form) =>
    [...plan.matchAll(wholeWord(form, "gu"))].some(({ index }) => {
      const before = plan.slice(0, index).match(/(\p{Lu}[\p{L}]*)\.?\s+$/u)?.[1];
      return before === undefined || TITLE.test(before) || nameForms(person).includes(before);
    }),
  );

// Where a plan turns from its deed to what that is for, whose people it isn't near, as a knife buried far off "meaning to meet Vane".
// shortcut: by the words moves use most; add to them if a far plan is offered for a name after another.
const PURPOSE = /\b(?:meaning|hoping|intending|so that|in order)\b/;
/** What a person shown with no name is called, such as the "rider" of "Rider on the crest". */
const calledBy = (person: string) => {
  if (!/\s\p{Ll}/u.test(person)) return undefined;
  const word = person.split(/\s(?:of|on|at|in|by|with|from|who|near|behind)\s/)[0]!.match(/\p{L}+$/u)?.[0];
  return word && word.length >= 4 && !common(word) ? word : undefined;
};

/**
 * The open plan to bring on in the coming reply, whose hour it reaches or has passed with no move to tell it: one that names the PC or someone with them, or else the
 * PC's place, as a far deed offered brought its news from nowhere. One at most, so events never crowd in. `again` is for a reply
 * that replaces one, whose own offer was counted.
 */
export function duePlan(id: string, state: State, pcName: string, pace = USUAL_PACE, again = false) {
  const clock = clockOf(state.storyTime);
  if (clock === undefined) return undefined;
  const most = MOST_OFFERS + (again ? 1 : 0);
  const company = [...state.scene.visibleCast, pcName].filter(Boolean);
  const place = (state.scene.location.match(/\p{L}{4,}/gu) ?? []).filter((word) => !common(word) && !ANY_PLACE.has(word.toLowerCase()));
  const nearness = (plan: string) => {
    const deed = plan.split(PURPOSE)[0]!;
    const shown = (word: string | undefined) => word !== undefined && wholeWord(word, "iu").test(deed);
    if (company.some((person) => names(deed, person) || shown(calledBy(person)))) return 2;
    return place.some(shown) ? 1 : 0;
  };
  const reach = clock + Math.min(Math.max(pace, USUAL_PACE), NEAR_HOURS) + ROUNDING;
  const [first] = Object.entries(state.threadsPlan)
    .flatMap(([truth, plan]) => {
      const due = state.threadsDue[truth];
      const near = nearness(plan);
      const coming = due !== undefined && due <= reach;
      return coming && near > 0 && (offered.get(id)?.get(plan) ?? 0) < most ? [{ plan, near, due }] : [];
    })
    .toSorted((a, b) => b.near - a.near || a.due - b.due);
  return first?.plan;
}

/**
 * Whether a reply asked to bring a plan on did: it tells the deed by two of its own words, whoever is named, as someone the PC
 * doesn't know goes unnamed, or by what words it has where the doer is named; or it brings the doer into view or has them speak,
 * as a packet handed over was told as "something pale passed". Never for a doer only spoken of.
 */
export function planShown(plan: string, before: State, after: State, narration: string) {
  const { doer, doerIn, mentions } = threadPeople(after);
  const words = deedWords(plan);
  const told = echoes(words, narration);
  const named = (doer(plan) ?? []).some((name) => mentions(narration, name, "u"));
  if (told >= 2 || (named && told >= Math.max(1, Math.min(2, words.length)))) return true;
  const speaks = [...narration.matchAll(/^\[([^[\]]+)\]:/gm)].some(([, speaker]) => doerIn(plan, [speaker!.trim()]));
  return !doerIn(plan, before.scene.visibleCast) && (speaks || doerIn(plan, after.scene.visibleCast));
}
