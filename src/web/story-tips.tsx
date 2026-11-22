import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { endTips } from "./api";

type TipsEnd = Parameters<typeof endTips>[0];

/** One line for each tool by the box, by the name its button carries, so a renamed tool fails the tips' test. */
const BOX_TIPS: Record<string, string> = {
  "Draw a picture": "Describe a picture and it's drawn from your words and the recent story.",
  "Ask the Narrator": "Ask an out-of-character question, like asking a game master. It changes nothing.",
  "Tell Narrator what to change": "Change the story or the world in your own words.",
  Choices: "Switch between picking one of three Choices and typing your own move.",
  "Decide for me": "With the box empty, the Narrator suggests a move. With words in it, it polishes them.",
  Enhance: "With the box empty, the Narrator suggests a move. With words in it, it polishes them.",
  Continue: "Send nothing and let the moment carry on around your PC.",
  Send: "Send your move. Everything you type is your PC's own words and actions.",
};
const ROW = "Tools under a response";
const ROW_TIP = "Under the latest response, Rewrite it from a note, Edit it yourself, or Regenerate it. The Reader's Guide covers the rest.";

const boxButton = (name: string) => document.querySelector<HTMLElement>(`.compose-actions button[aria-label="${name}"]`);
const latestRow = () => document.querySelector<HTMLElement>('.message .actions button[aria-label="Rewrite"]')?.closest<HTMLElement>(".actions");
const targetOf = (name: string) => (name === ROW ? latestRow() : boxButton(name));

/** The tools on screen now, left to right, then the row under the latest response if it has its tools. */
function tipsOnScreen() {
  const names = [...document.querySelectorAll<HTMLElement>(".compose-actions button[aria-label]")]
    .map((button) => [button.getAttribute("aria-label")!, button.getAttribute("aria-disabled") === "true"] as const)
    // A tool that can't be used now is passed over, but not Send, which is only waiting for words.
    .filter(([name, disabled]) => BOX_TIPS[name] && (name === "Send" || !disabled))
    .map(([name]) => name);
  return latestRow() ? [...names, ROW] : names;
}

/**
 * The first-time tips: one bubble at a time over the story screen's tools, once the first response is in, until the player
 * finishes or skips them, or plays on. `idle` is false while anything else stands over the screen, which only pauses them.
 */
export function useStoryTips({ seen, idle, playing, box }: { seen: boolean; idle: boolean; playing: boolean; box: RefObject<HTMLElement | null> }) {
  const [touring, setTouring] = useState(false);
  const ended = useRef(false);
  const end = (how: TipsEnd) => {
    if (ended.current) return;
    ended.current = true;
    setTouring(false);
    endTips(how).catch(() => {});
    if (how !== "left") box.current?.focus();
  };

  useEffect(() => {
    if (!seen && idle && !ended.current) setTouring(true);
  }, [seen, idle]);
  useEffect(() => {
    if (touring && playing) end("played");
  }, [touring, playing]);
  // Leaving the story ends them too, or they would stand over the next one opened in the same place.
  const leave = useRef(() => {});
  leave.current = () => touring && end("left");
  useEffect(() => () => leave.current(), []);

  return touring && <StoryTips shown={idle} onEnd={end} />;
}

function StoryTips({ shown, onEnd }: { shown: boolean; onEnd: (how: TipsEnd) => void }) {
  // Chosen when they start, from what is on screen then.
  const [names] = useState(tipsOnScreen);
  const [step, setStep] = useState(0);
  const bubble = useRef<HTMLDivElement>(null);
  const arrow = useRef<HTMLSpanElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const name = names[step];
  const last = step === names.length - 1;

  useEffect(() => {
    if (names.length === 0) onEnd("finished");
  }, []);

  useLayoutEffect(() => {
    if (!shown || !name) return;
    const target = targetOf(name);
    // Gone since they started, as the box changed: on to the next.
    if (!target) return last ? onEnd("finished") : setStep(step + 1);
    target.scrollIntoView({ block: "nearest" });
    // The row's tools show only on hover with a mouse.
    target.classList.add("tip-shown");
    next.current?.focus({ preventScroll: true });
    const place = () => {
      const at = target.getBoundingClientRect();
      const self = bubble.current!.getBoundingClientRect();
      const margin = 16;
      const gap = 12;
      // Above, as the tools sit at the foot of the screen, unless there's no room.
      const above = at.top - self.height - gap >= margin;
      const top = above ? at.top - self.height - gap : at.bottom + gap;
      const left = Math.min(Math.max(at.left + at.width / 2 - self.width / 2, margin), innerWidth - margin - self.width);
      Object.assign(bubble.current!.style, { top: `${top}px`, left: `${left}px` });
      bubble.current!.dataset.side = above ? "above" : "below";
      arrow.current!.style.left = `${Math.min(Math.max(at.left + at.width / 2 - left, 14), self.width - 14)}px`;
    };
    place();
    // A picture landing, the story scrolling or the box growing moves the tool.
    const watch = new ResizeObserver(place);
    watch.observe(document.body);
    watch.observe(target);
    addEventListener("resize", place);
    addEventListener("scroll", place, true);
    return () => {
      target.classList.remove("tip-shown");
      watch.disconnect();
      removeEventListener("resize", place);
      removeEventListener("scroll", place, true);
    };
  }, [shown, step]);

  if (!shown || !name) return null;
  return (
    <div
      ref={bubble}
      className="story-tip"
      role="dialog"
      aria-label={`Tip: ${name}`}
      onKeyDown={(e) => {
        if (e.key === "Escape") onEnd("skipped");
      }}
    >
      <p>
        <b>{name}</b>: {name === ROW ? ROW_TIP : BOX_TIPS[name]}
      </p>
      <div className="row">
        <span className="muted">
          {step + 1} of {names.length}
        </span>
        <button type="button" className="quiet" onClick={() => onEnd("skipped")}>
          Skip tips
        </button>
        <button ref={next} type="button" onClick={() => (last ? onEnd("finished") : setStep(step + 1))}>
          {last ? "Done" : "Next"}
        </button>
      </div>
      <span ref={arrow} className="tip-arrow" aria-hidden="true" />
    </div>
  );
}
