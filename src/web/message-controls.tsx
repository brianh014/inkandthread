import { type Ref, useState } from "react";
import type { Message, MessageCheck } from "./api";
import { isContinue } from "./chat-style";
import { ChapterIcon, DieIcon, DuplicateIcon, EditIcon, RegenerateIcon, RevertIcon, RewriteIcon } from "./icons";

/** What a Message's row of tools does. Only the latest response is replaceable, and only once no Turn is running. */
export type MessageActions = {
  replay: (message: Message) => void;
  revert: (message: Message) => void;
  duplicate: (message: Message) => void;
  toggleChapterEnd: () => void;
  rewrite: (message: Message) => void;
  edit: (message: Message) => void;
  regenerate: () => void;
};

/** The tools under one Message. */
export function MessageControls(props: {
  message: Message;
  latest: boolean;
  replaceable: boolean;
  /** Whether there is a Message before it, which an Edit and replay goes back to. */
  replayable: boolean;
  open: { rewrite: boolean; edit: boolean; chapterEnd: boolean };
  rewriteButton: Ref<HTMLButtonElement>;
  actions: MessageActions;
  /** Its Check, with Show Checks on. */
  check?: MessageCheck;
}) {
  const { message, latest, replaceable, replayable, open, rewriteButton, actions, check } = props;
  // A Continue's text is only its marker, so it is named instead.
  const words = isContinue(message) ? "Continue" : message.text.slice(0, 40);
  return (
    <div className="row actions">
      {check && <CheckDie check={check} />}
      {message.role === "player" && replayable && (
        <button
          type="button"
          className="icon"
          title="Edit and replay from here"
          aria-label={`Edit and replay from your words: ${words}`}
          onClick={() => actions.replay(message)}
        >
          {EditIcon}
        </button>
      )}
      {!latest && (
        <button
          type="button"
          className="icon revert"
          title="Revert to here"
          aria-label={`Revert to this Message: ${words}`}
          onClick={() => actions.revert(message)}
        >
          {RevertIcon}
        </button>
      )}
      <button
        type="button"
        className="icon revert"
        title="Duplicate from here"
        aria-label={`Duplicate from this Message: ${words}`}
        aria-haspopup="dialog"
        onClick={() => actions.duplicate(message)}
      >
        {DuplicateIcon}
      </button>
      {latest && (
        <button
          type="button"
          className="icon"
          title="End the chapter here"
          aria-label="End the chapter here"
          aria-expanded={open.chapterEnd}
          onClick={actions.toggleChapterEnd}
        >
          {ChapterIcon}
        </button>
      )}
      {replaceable && (
        <>
          <button
            type="button"
            ref={rewriteButton}
            className="icon"
            title="Rewrite"
            aria-label="Rewrite"
            aria-expanded={open.rewrite}
            onClick={() => actions.rewrite(message)}
          >
            {RewriteIcon}
          </button>
          <button type="button" className="icon" title="Edit" aria-label="Edit" aria-expanded={open.edit} onClick={() => actions.edit(message)}>
            {EditIcon}
          </button>
          <button type="button" className="icon" title="Regenerate" aria-label="Regenerate" aria-haspopup="dialog" onClick={actions.regenerate}>
            {RegenerateIcon}
          </button>
        </>
      )}
    </div>
  );
}

const RESULTS: Record<string, string> = {
  strong: "a great success",
  clean: "succeeded",
  mixed: "succeeded at a cost",
  plain: "failed",
  bad: "failed badly",
};

/** The die on a Message that had a Check: its difficulty, roll and result on hover, or on a tap, as a phone has no hover. */
function CheckDie({ check }: { check: MessageCheck }) {
  const [shown, setShown] = useState(false);
  const words = `${check.difficulty}, rolled ${check.roll}: ${RESULTS[check.degree] ?? check.outcome}. ${check.action}`;
  return (
    <>
      <button type="button" className="icon" title={words} aria-label={`Check: ${words}`} aria-expanded={shown} onClick={() => setShown(!shown)}>
        {DieIcon}
      </button>
      {shown && <span className="muted">{words}</span>}
    </>
  );
}
