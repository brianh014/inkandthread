import { type ReactNode, useId } from "react";
import type { Settings } from "./api";
import { BeatLine, type ChatStyle } from "./chat-style";

const SAMPLE_PC = "Wren";
// As a Turn reads: the player's move, then the Narrator's reply, its speech in quotes as the Narrator writes it.
const SAMPLE = [
  { role: "player", beats: [{ player: true, text: "I tip my hat and step aboard." }] },
  {
    role: "narrator",
    beats: [{ text: "Rain needles the harbour lanterns as the ferry noses in." }, { speaker: "Mara", text: "\"You're late. The tide won't wait.\"" }],
  },
];

export const CHAT_STYLES: { value: ChatStyle; label: string }[] = [
  { value: "prose", label: "Prose" },
  { value: "script", label: "Script" },
  { value: "bubbles", label: "Bubbles" },
];
export const THEMES: { value: Settings["theme"]; label: string }[] = [
  { value: "system", label: "Match this device" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];
const FONT_SIZES: { value: Settings["fontSize"]; label: string }[] = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
];

type Look = Pick<Settings, "chatStyle" | "theme" | "fontSize">;

/** One choice: its radio and name above what it looks like. */
function Sample(props: { name: string; label: string; checked: boolean; onPick: () => void; children: ReactNode }) {
  return (
    <label className="sample">
      <span>
        <input type="radio" name={props.name} checked={props.checked} onChange={props.onPick} /> {props.label}
      </span>
      {props.children}
    </label>
  );
}

/** How the story reads, picked from live samples drawn with the story's own styles, so they stay right as the styles change. */
export function ReadingSamples({ value, onChange }: { value: Look; onChange: (change: Partial<Look>) => void }) {
  // Settings and Setup can both be open in a tab's history, and radios group by name.
  const id = useId();
  const pick = <K extends keyof Look>(field: K, option: Look[K], label: string) => ({
    name: `${id}-${field}`,
    label,
    checked: value[field] === option,
    onPick: () => onChange({ [field]: option }),
  });

  return (
    <>
      <fieldset className="samples">
        <legend>How the story reads</legend>
        {CHAT_STYLES.map(({ value: style, label }) => (
          <Sample key={style} {...pick("chatStyle", style, label)}>
            {/* Wrapped as the story wraps each Message, so its styles apply as in play. */}
            <div className={`story chat-${style}`} aria-hidden="true">
              <div>
                {SAMPLE.map(({ role, beats }) => (
                  <div key={role} className={`message ${role}`}>
                    {beats.map((beat) => (
                      <BeatLine key={beat.text} beat={beat} style={style} pc={SAMPLE_PC} />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </Sample>
        ))}
      </fieldset>
      <fieldset className="samples">
        <legend>Light or dark</legend>
        {THEMES.map(({ value: theme, label }) => (
          <Sample key={theme} {...pick("theme", theme, label)}>
            <div className={`theme-sample ${theme}`} aria-hidden="true">
              <p>The tide won't wait.</p>
              <i />
            </div>
          </Sample>
        ))}
      </fieldset>
      <fieldset className="samples">
        <legend>Font size</legend>
        {FONT_SIZES.map(({ value: size, label }) => (
          <Sample key={size} {...pick("fontSize", size, label)}>
            <p className={`font-sample ${size}`} aria-hidden="true">
              The tide won't wait.
            </p>
          </Sample>
        ))}
      </fieldset>
    </>
  );
}
