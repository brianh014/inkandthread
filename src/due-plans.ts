// A hidden plan whose hour comes while the PC is near. Code knows each plan's hour and the Narrator only its words, so of 23 plans
// that came due in a bench play 4 reached the page, and the next move of the world told the rest as done out of sight, some at
// the PC's own camp.
import { EVERYDAY } from "./known-choices";
import { wholeWord } from "./lore-activation";
import { clockOf, nameForms, type State } from "./state-applier";
import { threadPeople } from "./thread-people";
import { sameDeed } from "./world-moves-on";

/** Story hours a reply is taken to pass until the story's own pace is known. */
const USUAL_PACE = 0.1;
/** How long after its hour a plan may still be brought on, where no move of the world has told it yet. */
const LATE_HOURS = 0.5;
/** The most replies one plan is offered to, so one the Narrator leaves out goes to the next move of the world. */
const MOST_OFFERS = 2;
// The words of a place that tell nothing of which, a direction among them, as "carries the lie north" put a far well at a north rock.
const JOINING = new Set(
  "the and above below between near inside outside behind under over from with into north south east west upper lower old new".split(" "),
);

/** How often each Save's plans have been offered. shortcut: in memory, so a restart offers a plan afresh; store it if one is played twice. */
const offered = new Map<string, Map<string, number>>();

/**
 * The open plan to bring on in the coming reply, whose hour it reaches: one that names the PC or someone with them, or else the
 * PC's place, as a far deed offered brought its news from nowhere. One at most, so events never crowd in.
 */
export function duePlan(id: string, state: State, pcName: string, pace = USUAL_PACE) {
  const clock = clockOf(state.storyTime);
  if (clock === undefined) return undefined;
  const { mentions } = threadPeople(state);
  const times = offered.get(id) ?? new Map<string, number>();
  const company = [...state.scene.visibleCast, pcName].flatMap(nameForms).filter(Boolean);
  const place = (state.scene.location.toLowerCase().match(/\p{L}{3,}/gu) ?? []).filter((word) => !EVERYDAY.has(word) && !JOINING.has(word));
  const nearness = (plan: string) => {
    if (company.some((name) => mentions(plan, name, "u"))) return 2;
    return place.some((word) => wholeWord(word, "iu").test(plan)) ? 1 : 0;
  };
  const [first] = Object.entries(state.threadsPlan)
    .flatMap(([truth, plan]) => {
      const due = state.threadsDue[truth];
      const near = nearness(plan);
      const coming = due !== undefined && due > clock - LATE_HOURS && due <= clock + pace;
      return coming && near > 0 && (times.get(plan) ?? 0) < MOST_OFFERS ? [{ truth, plan, near, due }] : [];
    })
    .toSorted((a, b) => b.near - a.near || a.due - b.due);
  if (!first) return undefined;
  offered.set(id, times.set(first.plan, (times.get(first.plan) ?? 0) + 1));
  return { truth: first.truth, plan: first.plan };
}

/** Whether a reply played a plan out: it names the plan's doer and has two of the deed's own words. */
export function planShown(plan: string, state: State, narration: string) {
  const { doer, mentions } = threadPeople(state);
  return (doer(plan)?.some((name) => mentions(narration, name, "u")) ?? false) && sameDeed(plan, narration);
}
