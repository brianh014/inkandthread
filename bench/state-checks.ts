// What code can tell wrong in a play's state without a judge, counted over its steps, as the one measure free of judge noise.
import { dayPart, knownOnly, type State } from "../src/state-applier";

/** Steps that tell new story, so story time should not go back; a Rewrite, Regenerate or Edit replaces a reply and may. */
const TURNS = new Set(["opening", "choice", "move", "continue", "continue (no Choices)"]);
const same = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export function stateFaults(steps: { action: string; before: State; after: State }[]) {
  const faults = { timeBack: 0, repeatKnows: 0, negativeKnows: 0, looseEndReopened: 0 };
  const resolved = new Set<string>();
  for (const { action, before, after } of steps) {
    const [was, now] = [before.storyTime, after.storyTime];
    if (TURNS.has(action) && was && now) {
      const [wasPart, nowPart] = [dayPart(was.timeOfDay), dayPart(now.timeOfDay)];
      if (now.day < was.day || (now.day === was.day && wasPart !== undefined && nowPart !== undefined && nowPart < wasPart)) faults.timeBack++;
    }
    for (const [name, known] of Object.entries(after.npcKnows)) {
      const earlier = before.npcKnows[name] ?? [];
      known.forEach((fact, at) => {
        if (earlier.includes(fact)) return;
        if (known.some((other, otherAt) => otherAt !== at && same(other) === same(fact) && (otherAt < at || earlier.includes(other)))) faults.repeatKnows++;
        if (knownOnly(fact) !== fact) faults.negativeKnows++;
      });
    }
    for (const end of after.looseEnds) if (!before.looseEnds.includes(end) && resolved.has(end)) faults.looseEndReopened++;
    for (const end of before.looseEnds) if (!after.looseEnds.includes(end)) resolved.add(end);
  }
  const flat: Record<string, number> = Object.fromEntries(Object.entries(faults).map(([key, value]) => [`stateFaults.${key}`, value]));
  flat["stateFaults.total"] = Object.values(faults).reduce((a, b) => a + b, 0);
  return flat;
}
