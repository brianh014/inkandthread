import { OWN_TONE, TONE_MAX, TONES, WORLDS_OWN } from "../tones";
import { Choices } from "./art-style-picker";

/** The Tone, on the New Story form and in the Journal. */
export function TonePicker(props: { tone: string; ownTone: string; onChange: (pick: { tone: string; ownTone: string }) => void }) {
  const { tone, ownTone, onChange } = props;
  return (
    <>
      <Choices
        legend="How should it be told?"
        options={[WORLDS_OWN, ...Object.keys(TONES), OWN_TONE]}
        value={tone}
        onChange={(picked) => onChange({ tone: picked, ownTone })}
      />
      <p className="muted">{TONES[tone] ?? (tone === WORLDS_OWN ? "In the mood the theme gives it." : "")}</p>
      {tone === OWN_TONE && (
        <label>
          What is your tone?
          <input maxLength={TONE_MAX} value={ownTone} onChange={(e) => onChange({ tone, ownTone: e.target.value })} />
        </label>
      )}
    </>
  );
}
