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
/** How long past its hour a plan no move has told may still be brought on: over a night's sleep, never days later. */
const PAST_HOURS = 12;
/** Added to the reach, as 43.75 and 0.05 came to a hair under the 43.8 a plan was due. */
const ROUNDING = 0.01;
// The words of a place that tell nothing of which, as "carries the lie north" put a far well at a north rock.
const ANY_PLACE = new Set(
  "north south east west upper lower above below between near inside outside behind under over house hall road street door hers their mouth edge side".split(
    " ",
  ),
);

/**
 * The plans each Save's committed Turns were offered, once each, by the reply each Turn followed, so a reply written again or a
 * Turn reverted takes its own offer with it and no other: 19 of 20 replayed replies brought theirs on at the first, some by
 * signs no words of it told, such as tracks in the sand, and one offered again would play twice. One left out goes to the next
 * move of the world. shortcut: in memory, so a restart offers a plan afresh; store it if one is played twice.
 */
const offered = new Map<string, Map<string, number>>();
export const planOffered = (id: string, plan: string, after: number) => {
  offered.set(id, (offered.get(id) ?? new Map<string, number>()).set(plan, after));
};
/** The reply a Turn follows, by its Message. */
export const replyBefore = (messages: { id: number; role: string }[]) => messages.findLast(({ role }) => role === "narrator")?.id ?? 0;

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

// What a plan's deed is for, whose people it isn't near, as a knife buried far off "meaning to meet Vane".
// shortcut: by the words moves use most; add to them if a far plan is offered for a name after another.
const PURPOSE = /\b(?:meaning to|hoping to|intending to|so that|in order to)\b[^,;.]*/g;
// Where what someone with no name is called ends, as "Man holding a lantern" is no lantern.
const CALLED_UNTIL = /,|\s(?:\p{Ll}+ing|of|on|at|in|by|with|from|who|near|behind|under|beneath|beside|above|below|across|over|among|between|through|to)\s/u;
/** Whether a plan is by or for someone shown with no name, by what they are called, such as "the rider" for "Rider on the crest". */
const calls = (plan: string, person: string) => {
  const called = person.split(CALLED_UNTIL)[0]!.trim();
  const word =
    called
      .match(/\p{L}+$/u)?.[0]
      .toLowerCase()
      .replace(/s$/, "") ?? "";
  // Never by a name's last part, as "Mara Vell of Harrow" is no other Vell and "Hob Miller" no miller.
  if (/\s\p{Lu}/u.test(called) || word.length < 4 || common(word)) return false;
  return new RegExp(`\\b[Tt]he (?:\\p{Ll}+ )?${word}s?\\b`, "u").test(plan);
};

/**
 * The open plan to bring on in the coming reply, whose hour it reaches or has passed with no move to tell it: one that names the
 * PC or someone with them, or else the PC's place, as a far deed offered brought its news from nowhere. One at most, so events
 * never crowd in. `after` is the reply the coming one follows.
 */
export function duePlan(id: string, state: State, pcName: string, after: number, pace = USUAL_PACE) {
  const clock = clockOf(state.storyTime);
  if (clock === undefined) return undefined;
  const company = [...state.scene.visibleCast, pcName].filter(Boolean);
  const place = (state.scene.location.match(/\p{L}{4,}/gu) ?? []).filter((word) => !common(word) && !ANY_PLACE.has(word.toLowerCase()));
  const nearness = (plan: string) => {
    const deed = plan.replace(PURPOSE, "");
    if (company.some((person) => names(deed, person)) || state.scene.visibleCast.some((person) => calls(deed, person))) return 2;
    return place.some((word) => wholeWord(word, "iu").test(deed)) ? 1 : 0;
  };
  const spent = (plan: string) => (offered.get(id)?.get(plan) ?? Number.POSITIVE_INFINITY) < after;
  const reach = clock + Math.min(Math.max(pace, USUAL_PACE), NEAR_HOURS) + ROUNDING;
  const [first] = Object.entries(state.threadsPlan)
    .flatMap(([truth, plan]) => {
      const due = state.threadsDue[truth];
      const near = nearness(plan);
      // Never one with no hour, as a story opens with plans that are for later.
      const coming = due !== undefined && due > clock - PAST_HOURS && due <= reach;
      return coming && near > 0 && !spent(plan) ? [{ plan, near, due }] : [];
    })
    .toSorted((a, b) => b.near - a.near || Math.abs(a.due - clock) - Math.abs(b.due - clock));
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
