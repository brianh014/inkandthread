/** Each Tone says only how the story is told, never what happens in it, and is sent to the Narrator with its name. */
export const TONES: Record<string, string> = {
  Lighthearted: "Warm, easy-going narration with a light touch and room for humour.",
  Wry: "Dry, ironic narration that notices the absurd and says it deadpan.",
  Whimsical: "Playful, fanciful narration that delights in the odd and the strange.",
  Earnest: "Sincere, heartfelt narration that says feelings plainly and means them.",
  Melancholic: "Wistful, reflective narration, quiet and bittersweet.",
  Grim: "Bleak, unsparing narration that looks hard things in the face and never softens them.",
};

/** A player's own Tone, which rides on every Turn, so it stays one short line. */
export const TONE_MAX = 150;

/** A Tone's name for the log, as a player's own is their words. */
export const toneName = (tone: string) => (!tone ? "none" : (Object.keys(TONES).find((name) => tone === `${name}: ${TONES[name]}`) ?? "own"));

/** The default, which sets no Tone, so the theme carries the mood. */
export const WORLDS_OWN = "The world's own";
export const OWN_TONE = "Create your own";

/** The pick a stored Tone is: a built-in one is stored with its description, so anything else is the player's own. */
export function toneFor(text: string) {
  if (!text) return { tone: WORLDS_OWN, ownTone: "" };
  const name = Object.keys(TONES).find((tone) => text === `${tone}: ${TONES[tone]}`);
  return name ? { tone: name, ownTone: "" } : { tone: OWN_TONE, ownTone: text };
}

/** What a pick stores and sends the Narrator, empty for none. */
export const toneText = (tone: string, ownTone: string) =>
  tone === OWN_TONE ? ownTone.trim().slice(0, TONE_MAX) : TONES[tone] ? `${tone}: ${TONES[tone]}` : "";
