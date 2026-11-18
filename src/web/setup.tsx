import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { askTextTest, getImageModels, getSettings, getTextModels, offersDecisions, type Settings, saveSettings, setupProblem } from "./api";
import type { SettingsChange } from "../settings-store";
import { BeatLine, type ChatStyle, roman } from "./chat-style";
import { MenuRibbon, Sheet } from "./menu";
import {
  applyLook,
  ComfySettings,
  ConsistencySettings,
  ModelField,
  Picker,
  ReviewSettings,
  TEXT_CHOICES,
  TEXT_PROVIDERS,
  TestBox,
  TextResult,
  textChoiceOf,
} from "./settings";

const STEPS = ["Welcome", "The storyteller", "Its model", "A second reader", "A careful eye", "Pictures", "Reading", "Ready"];
const [PROVIDER, MODEL, REVIEW, CONSISTENCY, PICTURES, READING, READY] = [1, 2, 3, 4, 5, 6, 7];
// From the second reader on, a step can be passed over.
const SKIPPABLE = [REVIEW, CONSISTENCY, PICTURES, READING];
// What each step's Next saves, by setting name, and nothing else, so leaving halfway loses nothing done.
const STEP_FIELDS: Record<number, RegExp> = {
  [PROVIDER]: /^(textBaseUrl|textModel|textHost|reviewModel|consistencyModel)$/,
  [MODEL]: /^text(Model|Host|Thinking)$/,
  [REVIEW]: /^review/,
  [CONSISTENCY]: /^consistency/,
  [PICTURES]: /^(image|comfy)/,
  [READING]: /^(theme|chatStyle|showChecks)$/,
};

// Each provider's own pages. The README names the same pages, so change them together.
const LINKS: Record<string, [string, string][]> = {
  openrouter: [
    ["Sign up", "https://openrouter.ai"],
    ["Add credit", "https://openrouter.ai/settings/credits"],
    ["Make a key", "https://openrouter.ai/settings/keys"],
  ],
  google: [
    ["Sign in", "https://aistudio.google.com"],
    ["Get a key", "https://aistudio.google.com/apikey"],
  ],
  nanogpt: [
    ["Sign up", "https://nano-gpt.com"],
    ["Make a key", "https://nano-gpt.com/api"],
  ],
  wiro: [
    ["Sign up", "https://wiro.ai"],
    ["Make a key", "https://wiro.ai/panel/project"],
  ],
  comfy: [["Download ComfyUI", "https://www.comfy.org/download"]],
};

const ProviderLinks = ({ provider }: { provider: string }) =>
  LINKS[provider] && (
    <ul className="setup-links">
      {LINKS[provider].map(([label, href]) => (
        <li key={href}>
          <a href={href} target="_blank" rel="noreferrer">
            {label}
          </a>
        </li>
      ))}
    </ul>
  );

const IMAGE_CHOICES = [
  { value: "openrouter", label: "OpenRouter" },
  { value: "nanogpt", label: "NanoGPT" },
  { value: "google", label: "Google AI Studio" },
  { value: "wiro", label: "Wiro" },
] as const;

const SAMPLE_PC = "Wren";
const SAMPLE = [
  { text: "Rain needles the harbour lanterns as the ferry noses in." },
  { speaker: "Mara", text: "You're late. The tide won't wait for you." },
  { player: true, text: "I tip my hat and step aboard." },
];
const CHAT_STYLES: { value: ChatStyle; label: string }[] = [
  { value: "prose", label: "Prose" },
  { value: "script", label: "Script" },
  { value: "bubbles", label: "Bubbles" },
];
const THEMES: { value: Settings["theme"]; label: string }[] = [
  { value: "system", label: "Match this device" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const textName = (url: string) => TEXT_CHOICES.find(({ value }) => value === textChoiceOf(url))!.label;

/** The Prologue: walks a new player through the Settings that matter, one page each, and saves each page's own as it goes. */
export function Setup() {
  const [saved, setSaved] = useState<Settings>();
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    getSettings().then(setSaved, (failure: Error) => setLoadError(failure.message));
  }, []);

  if (!saved)
    return (
      <Sheet tabs={<MenuRibbon />}>
        {loadError && (
          <p role="alert" className="error">
            {loadError}
          </p>
        )}
      </Sheet>
    );
  return <Steps initial={saved} />;
}

function Steps({ initial }: { initial: Settings }) {
  const [here, setHere] = useState(0);
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial);
  // Only what the player types now, as the server never sends a stored key.
  const [textKey, setTextKey] = useState("");
  const [reviewKey, setReviewKey] = useState("");
  const [consistencyKey, setConsistencyKey] = useState("");
  const [imageKey, setImageKey] = useState("");
  // The text key typed on this run, so OpenRouter's pictures can use it too.
  const [typedTextKey, setTypedTextKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (change: Partial<Settings>) => setDraft({ ...draft, ...change });

  const textChoice = textChoiceOf(draft.textBaseUrl);
  const local = textChoice === "local";
  const [models, setModels] = useState<string[]>();
  const [imageModels, setImageModels] = useState<string[]>();

  useEffect(() => {
    setModels(undefined);
    let current = true;
    getTextModels().then(
      (list) => current && setModels(list),
      () => current && setModels([]),
    );
    return () => {
      current = false;
    };
  }, [saved]);

  useEffect(() => {
    setImageModels(undefined);
    if (draft.imageProvider === "local") return;
    let current = true;
    getImageModels(draft.imageProvider).then(
      (list) => current && setImageModels(list),
      () => current && setImageModels([]),
    );
    return () => {
      current = false;
    };
  }, [draft.imageProvider, saved]);

  const keyNeeded = !local && !textKey.trim() && !saved.textKeysFor.includes(draft.textBaseUrl);
  const copiesTextKey =
    draft.imageProvider === "openrouter" && textChoice === "openrouter" && !!typedTextKey && !saved.imageKeysFor.includes("openrouter") && !imageKey.trim();
  const pictures = !draft.imagesEnabled ? "none" : draft.imageProvider === "local" ? "comfy" : "online";

  const keys = (): SettingsChange => {
    if (here === PROVIDER) return textKey.trim() ? { textApiKey: textKey.trim() } : {};
    if (here === REVIEW && draft.reviewOtherModel && !draft.reviewSameProvider && reviewKey.trim()) return { reviewApiKey: reviewKey.trim() };
    if (here === CONSISTENCY && draft.consistencyEnabled && (!draft.consistencySameProvider || !offersDecisions(draft.textBaseUrl)) && consistencyKey.trim())
      return { consistencyApiKey: consistencyKey.trim() };
    if (here === PICTURES && pictures === "online") {
      // Still saved as the image key, so changing one later leaves the other.
      const key = imageKey.trim() || (copiesTextKey ? typedTextKey : "");
      if (key) return { imageApiKey: key };
    }
    return {};
  };

  async function saveStep() {
    const fields = STEP_FIELDS[here];
    if (!fields) return;
    const change = Object.fromEntries(Object.entries(draft).filter(([name]) => fields.test(name) && !/(KeysFor|Profiles)$/.test(name)));
    const next = await saveSettings({ ...change, ...keys() });
    if (here === PROVIDER && textKey.trim()) setTypedTextKey(textKey.trim());
    setSaved(next);
    setDraft(next);
    setTextKey("");
    setReviewKey("");
    setConsistencyKey("");
    setImageKey("");
    applyLook(next);
  }

  // Leaving a page any way but Next drops what it changed, as only Next saves.
  const go = (step: number) => {
    setDraft(saved);
    applyLook(saved);
    setError("");
    setHere(step);
  };

  async function next(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await saveStep();
      setHere(here + 1);
    } catch (failure) {
      setError((failure as Error).message);
    }
    setBusy(false);
  }

  const blocked = (here === PROVIDER && keyNeeded) || (here === MODEL && !draft.textModel.trim());
  const ready = !setupProblem(saved);

  const pages: Record<number, ReactNode> = {
    0: (
      <>
        <p>
          NovelForge brings no AI of its own. It needs one to write the story, and can use another to draw its pictures. A few pages set them up, with what we
          recommend beside each.
        </p>
        <ul>
          <li>
            <b>An AI that writes</b>: needed. A hosted one costs a little each Turn; one on your own computer is free but suits short stories.
          </li>
          <li>
            <b>An AI that draws</b>: optional. Online it costs a little per picture; your own ComfyUI draws for free on a good graphics card.
          </li>
        </ul>
        <p className="muted">Everything here is in Settings too, to change any time, and Settings → Setup brings these pages back.</p>
      </>
    ),
    [PROVIDER]: (
      <>
        <p>Where the Narrator, the AI that writes your story, comes from.</p>
        <Picker
          label="Text provider"
          value={textChoice}
          choices={[...TEXT_CHOICES]}
          onChange={(provider) => {
            // As in Settings: a provider switched to brings back its own model, and Local the last local server.
            const lastLocal = Object.keys(saved.textProfiles).findLast((at) => !Object.values(TEXT_PROVIDERS).includes(at)) ?? "";
            const textBaseUrl = provider === "local" ? lastLocal : TEXT_PROVIDERS[provider];
            set({
              textBaseUrl,
              ...(saved.textProfiles[textBaseUrl] ?? { textModel: "", textHost: "" }),
              ...(draft.reviewSameProvider && { reviewModel: "" }),
              ...(draft.consistencySameProvider && { consistencyModel: "" }),
            });
          }}
        />
        <p className="muted">
          {
            {
              openrouter:
                "Recommended. One account and key reach every model, the drawing ones too, and you pay only for what you use. Sign up, add a few dollars of credit, then make a key and paste it below. It's shown only once, so keep a copy.",
              google:
                "A free key with a Google account, to try NovelForge. The free tier limits how many Turns a day you get, and Google may use what you send, your story among it, to improve its products.",
              nanogpt: "Pay as you go for many models, with one key.",
              local:
                "An AI on your own computer, or any other OpenAI-compatible server. Nothing leaves your computer, but a long story outgrows a 10 GB graphics card, so it suits short stories, privacy and trying things out. Ollama is at http://localhost:11434/v1, LM Studio at http://localhost:1234/v1.",
            }[textChoice]
          }
        </p>
        <ProviderLinks provider={textChoice} />
        {local && (
          <label>
            Server address
            <input
              type="url"
              required
              placeholder="http://localhost:1234/v1"
              value={draft.textBaseUrl}
              onChange={(e) => set({ textBaseUrl: e.target.value })}
            />
          </label>
        )}
        <label>
          {local ? "Text API key (most local servers need none)" : "Text API key"}
          <input
            type="password"
            autoComplete="new-password"
            placeholder={saved.textKeysFor.includes(draft.textBaseUrl) ? "Saved. Type a new key to replace it." : "None saved"}
            value={textKey}
            onChange={(e) => setTextKey(e.target.value)}
          />
        </label>
      </>
    ),
    [MODEL]: (
      <>
        <p className="muted">
          {/* The Guide and README name the same models, so change them together. */}
          {
            {
              openrouter:
                "Two good choices: MiMo V2.6 Pro (search “mimo pro”), for richer role-play and writing at a little more a Turn, or DeepSeek V4.1 Flash (search “deepseek flash”), much cheaper a Turn, with writing not quite as rich. Try both on one story and keep the one you like.",
              google: "We recommend a Gemini Flash model.",
              nanogpt: "Look for MiMo or DeepSeek, or choose any model you like.",
              local: "Choose the model your server runs. MiMo and DeepSeek write well if you can run them.",
            }[textChoice]
          }
        </p>
        <ModelField
          key={draft.textBaseUrl}
          label="Text model"
          value={draft.textModel}
          list={models}
          onChange={(textModel) => set({ textModel, textHost: textModel === draft.textModel ? draft.textHost : "" })}
        />
        {models?.length === 0 && <p className="muted">No models listed. Make sure the key or server is right, or type the model's name.</p>}
        {!local && (
          <>
            <Picker
              label="Thinking"
              value={draft.textThinking}
              choices={[
                { value: "default", label: "The model's own" },
                { value: "low", label: "Low" },
                { value: "medium", label: "Medium" },
                { value: "high", label: "High" },
              ]}
              onChange={(textThinking) => set({ textThinking })}
            />
            <p className="muted">
              How long a model that thinks before it writes may think. Medium is a good start. On High, some models think past their limit, and the reply is
              stopped and asked again, which can fail every try.
            </p>
          </>
        )}
        <TestBox
          title="Test text"
          hint="Saves this page, then sends the prompt to your model. A paid provider may charge a little for it. Not required."
          working="Asking…"
          run={async (prompt, signal) => {
            await saveStep();
            return askTextTest(prompt, signal);
          }}
        >
          {(result) => <TextResult {...result} />}
        </TestBox>
      </>
    ),
    [REVIEW]: (
      <>
        {/* The Guide and README name the same model, so change them together. */}
        <p>Recommended: a second model makes the story better. We recommend GPT-6.1 Luna (search “luna”).</p>
        <ReviewSettings draft={draft} saved={saved} set={set} narratorModels={models} reviewKey={reviewKey} setReviewKey={setReviewKey} />
      </>
    ),
    [CONSISTENCY]: (
      <>
        {!offersDecisions(draft.textBaseUrl) && <p className="muted">Decision models come from OpenRouter or NanoGPT, so this needs a key for one of them.</p>}
        <ConsistencySettings draft={draft} saved={saved} set={set} consistencyKey={consistencyKey} setConsistencyKey={setConsistencyKey} />
      </>
    ),
    [PICTURES]: (
      <>
        <p>NovelForge can draw the Cover, a portrait of each person and the scene as the story moves.</p>
        <fieldset className="setup-paths">
          <legend>Pictures</legend>
          <label className="toggle">
            <input type="radio" name="pictures" checked={pictures === "none"} onChange={() => set({ imagesEnabled: false })} />
            Text only
          </label>
          <label className="toggle">
            <input
              type="radio"
              name="pictures"
              checked={pictures === "online"}
              onChange={() => {
                const imageProvider = draft.imageProvider === "local" ? "openrouter" : draft.imageProvider;
                set({
                  imagesEnabled: true,
                  imageProvider,
                  ...(imageProvider !== draft.imageProvider && (saved.imageProfiles[imageProvider] ?? { imageModel: "" })),
                });
              }}
            />
            Online, the easy way
          </label>
          <label className="toggle">
            <input type="radio" name="pictures" checked={pictures === "comfy"} onChange={() => set({ imagesEnabled: true, imageProvider: "local" })} />
            Your own ComfyUI, free pictures
          </label>
        </fieldset>
        {pictures === "online" && (
          <>
            <p className="muted">For anyone without a good graphics card. Each picture costs a little.</p>
            <Picker
              label="Image provider"
              value={draft.imageProvider as (typeof IMAGE_CHOICES)[number]["value"]}
              choices={[...IMAGE_CHOICES]}
              onChange={(imageProvider) => set({ imageProvider, ...(saved.imageProfiles[imageProvider] ?? { imageModel: "" }) })}
            />
            <p className="muted">
              {/* The Guide and README name the same models, so change them together. */}
              {
                {
                  openrouter:
                    "Nano Banana 2.1 (search “nano banana”) gives a good balance of cost and quality, or Seedream 5.5 (search “seedream”) costs less.",
                  nanogpt: "Many image models with one key.",
                  google: "Nano Banana with your AI Studio key. Pictures aren't on the free tier, so turn on billing in AI Studio first.",
                  wiro: "Many image models. Set your Wiro project to API key only, not signatures.",
                  local: "",
                }[draft.imageProvider]
              }
            </p>
            <ProviderLinks provider={draft.imageProvider} />
            <label>
              Image API key
              <input
                type="password"
                autoComplete="new-password"
                placeholder={
                  saved.imageKeysFor.includes(draft.imageProvider)
                    ? "Saved. Type a new key to replace it."
                    : copiesTextKey
                      ? "Your OpenRouter text key. Type another to use that instead."
                      : "None saved"
                }
                value={imageKey}
                onChange={(e) => setImageKey(e.target.value)}
              />
            </label>
            <ModelField
              key={draft.imageProvider}
              label="Image model"
              value={draft.imageModel}
              list={imageModels}
              onChange={(imageModel) => set({ imageModel })}
            />
          </>
        )}
        {pictures === "comfy" && (
          <>
            <p className="muted">
              For a good graphics card. NovelForge draws a lot, the Cover, portraits, scenes and every redraw, and each costs money online but nothing here. We
              recommend FLUX.2 or Qwen Image 2.1, which keep faces the same from picture to picture. The Reader's Guide says how to install ComfyUI, and
              Advanced workflows are in Settings → Images.
            </p>
            <ProviderLinks provider="comfy" />
            <ComfySettings draft={draft} saved={saved} set={set} />
          </>
        )}
      </>
    ),
    [READING]: (
      <>
        <fieldset className="samples">
          <legend>How the story reads</legend>
          {CHAT_STYLES.map(({ value, label }) => (
            <label key={value} className="sample">
              <span>
                <input type="radio" name="chat-style" checked={draft.chatStyle === value} onChange={() => set({ chatStyle: value })} /> {label}
              </span>
              <div className={`story chat-${value}`} aria-hidden="true">
                {SAMPLE.map((beat) => (
                  <BeatLine key={beat.text} beat={beat} style={value} pc={SAMPLE_PC} />
                ))}
              </div>
            </label>
          ))}
        </fieldset>
        <fieldset className="samples">
          <legend>Light or dark</legend>
          {THEMES.map(({ value, label }) => (
            <label key={value} className="sample">
              <span>
                <input
                  type="radio"
                  name="theme"
                  checked={draft.theme === value}
                  onChange={() => {
                    set({ theme: value });
                    applyLook({ ...draft, theme: value });
                  }}
                />{" "}
                {label}
              </span>
              <div className={`theme-sample ${value}`} aria-hidden="true">
                <p>The tide won't wait.</p>
                <i />
              </div>
            </label>
          ))}
        </fieldset>
        <h3>Dice</h3>
        <p>
          When your character tries something that could fail, or someone reacts to what they do, the Narrator rolls hidden dice, and the story follows the
          result. You can keep the rolls hidden, or see each one.
        </p>
        <label className="toggle">
          <input type="checkbox" checked={draft.showChecks} onChange={(e) => set({ showChecks: e.target.checked })} />
          Show Checks
        </label>
      </>
    ),
    [READY]: (
      <>
        <p>{ready ? "NovelForge is ready." : "The story needs its Narrator set up first: go back to The storyteller."}</p>
        <dl className="test-stats">
          <dt>Narrator</dt>
          <dd>
            {textName(saved.textBaseUrl)}, {saved.textModel || "no model"}
          </dd>
          <dt>Second reader</dt>
          <dd>{saved.reviewOtherModel && saved.reviewModel ? saved.reviewModel : "The Narrator's own"}</dd>
          <dt>Consistency</dt>
          <dd>{saved.consistencyEnabled && saved.consistencyModel ? saved.consistencyModel : "Off"}</dd>
          <dt>Pictures</dt>
          <dd>
            {!saved.imagesEnabled
              ? "Text only"
              : saved.imageProvider === "local"
                ? "Your own ComfyUI"
                : `${IMAGE_CHOICES.find(({ value }) => value === saved.imageProvider)?.label}, ${saved.imageModel || "no model"}`}
          </dd>
          <dt>Reading</dt>
          <dd>
            {CHAT_STYLES.find(({ value }) => value === saved.chatStyle)?.label ?? saved.chatStyle}, {THEMES.find(({ value }) => value === saved.theme)?.label},{" "}
            {saved.showChecks ? "Checks shown" : "dice hidden"}
          </dd>
        </dl>
      </>
    ),
  };

  const last = here === READY;
  return (
    <Sheet
      view={here}
      lockRail={busy}
      tabs={<MenuRibbon />}
      rail={
        <nav aria-label="Steps" className="wizard-steps">
          {STEPS.map((name, index) => {
            const label = `${roman(index + 1)}. ${name}`;
            if (index === here)
              return (
                <span key={name} aria-current="step">
                  {label}
                </span>
              );
            // Ahead only once the Narrator is set up, as play needs it.
            return index < here || ready ? (
              <button key={name} type="button" onClick={() => go(index)}>
                {label}
              </button>
            ) : (
              <span key={name}>{label}</span>
            );
          })}
        </nav>
      }
      foot={
        <>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {here === PROVIDER && keyNeeded && <p className="muted">Paste your key to go on.</p>}
          <div className="row">
            {here > 0 && (
              <button type="button" className="quiet" onClick={() => go(here - 1)}>
                Back
              </button>
            )}
            {SKIPPABLE.includes(here) && (
              <button type="button" className="quiet" onClick={() => go(here + 1)}>
                Skip
              </button>
            )}
            {last ? (
              <>
                <a className="quiet" href="#/">
                  Back to the Menu
                </a>
                {ready && (
                  <a className="action" href="#/new">
                    Begin a New Story
                  </a>
                )}
              </>
            ) : (
              <button type="submit" form="setup-step" className="action" aria-disabled={busy || blocked}>
                {here === 0 ? "Begin" : "Next"}
              </button>
            )}
          </div>
        </>
      }
    >
      <form id="setup-step" className="fields settings" onSubmit={(event) => (blocked ? event.preventDefault() : next(event))}>
        <p className="eyebrow">
          Prologue · <span className="numeral">{roman(here + 1).toLowerCase()}</span>
        </p>
        <h1 className="big">{STEPS[here]}</h1>
        {pages[here]}
      </form>
    </Sheet>
  );
}
