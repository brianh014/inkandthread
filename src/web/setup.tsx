import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { askTextTest, getImageModels, getSettings, getTextModels, type Settings, saveSettings, setupProblem } from "./api";
import type { SettingsChange } from "../settings-store";
import { BenchChartButton } from "./bench-chart";
import { roman } from "./chat-style";
import { MenuRibbon, Sheet } from "./menu";
import { CHAT_STYLES, ReadingSamples, THEMES } from "./reading-samples";
import {
  applyLook,
  CommandField,
  useCommandLine,
  ComfySettings,
  LockedCommand,
  ModelField,
  narratorChoices,
  Picker,
  ReviewSettings,
  TEXT_CHOICES,
  TEXT_PROVIDERS,
  TestBox,
  TextResult,
  textChoiceOf,
} from "./settings";

const STEPS = ["Welcome", "The storyteller", "Its model", "The Scribe", "Pictures", "Reading", "Ready"];
const [PROVIDER, MODEL, REVIEW, PICTURES, READING, READY] = [1, 2, 3, 4, 5, 6];
// From the Scribe on, a step can be passed over.
const SKIPPABLE = [REVIEW, PICTURES, READING];
// What each step's Next saves, by setting name, and nothing else, so leaving halfway loses nothing done.
const STEP_FIELDS: Record<number, RegExp> = {
  [PROVIDER]: /^(textBaseUrl|textCommand|textModel|textHost|reviewModel)$/,
  [MODEL]: /^text(Model|Host|Thinking)$/,
  [REVIEW]: /^review/,
  [PICTURES]: /^(image|comfy)/,
  [READING]: /^(theme|chatStyle|fontSize|showChecks)$/,
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
  const [imageKey, setImageKey] = useState("");
  // Unset follows whether this provider already has its own image key.
  const [useTextKey, setUseTextKey] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (change: Partial<Settings>) => setDraft({ ...draft, ...change });
  const commandBox = useCommandLine(initial, set);
  const command = commandBox.line !== undefined;

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

  const keyNeeded = !command && !local && !textKey.trim() && !saved.textKeysFor.includes(draft.textBaseUrl);
  // One key does both when the pictures come from the Narrator's own service, and it has a key saved.
  const sharesKey = textChoiceOf(saved.textBaseUrl) === draft.imageProvider && saved.textKeysFor.includes(saved.textBaseUrl);
  const textKeyDraws = sharesKey && (useTextKey ?? !saved.imageKeysFor.includes(draft.imageProvider));
  const pictures = !draft.imagesEnabled ? "none" : draft.imageProvider === "local" ? "comfy" : "online";

  const keys = (): SettingsChange & { imageKeyFromText?: boolean } => {
    if (here === PROVIDER) return textKey.trim() ? { textApiKey: textKey.trim() } : {};
    if (here === REVIEW && draft.reviewOtherModel && !draft.reviewSameProvider && reviewKey.trim()) return { reviewApiKey: reviewKey.trim() };
    if (here === PICTURES && pictures === "online") {
      // Copied by the server as the image key, so changing one later leaves the other.
      if (textKeyDraws) return { imageKeyFromText: true };
      if (imageKey.trim()) return { imageApiKey: imageKey.trim() };
    }
    return {};
  };

  async function saveStep() {
    const fields = STEP_FIELDS[here];
    if (!fields) return;
    const change = Object.fromEntries(Object.entries(draft).filter(([name]) => fields.test(name) && !/(KeysFor|Profiles)$/.test(name)));
    const next = await saveSettings({ ...change, ...keys() });
    setSaved(next);
    setDraft(next);
    setTextKey("");
    setReviewKey("");
    setImageKey("");
    applyLook(next);
  }

  // Leaving a page any way but Next drops what it changed, as only Next saves.
  const go = (step: number) => {
    setDraft(saved);
    commandBox.reset(saved);
    applyLook(saved);
    setError("");
    setHere(step);
  };

  // `onward` goes to the next page once saved; without it the page stays, so its lists and tests can use what was just typed.
  async function save(onward: boolean) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await saveStep();
      if (onward) setHere(here + 1);
    } catch (failure) {
      setError((failure as Error).message);
    }
    setBusy(false);
  }

  const next = (event: FormEvent) => {
    event.preventDefault();
    void save(true);
  };

  // The image lists and ComfyUI's Test only reach a saved address and key, as in Settings.
  const saveHere = (
    <>
      <button type="button" className="quiet" aria-disabled={busy} onClick={() => void save(false)}>
        Save to list models
      </button>
      <p className="muted">Saves this page and stays on it, so the model lists and Test can use the address or key you typed.</p>
    </>
  );

  const blocked = (here === PROVIDER && keyNeeded) || (here === MODEL && !command && !draft.textModel.trim());
  const ready = !setupProblem(saved);

  const pages: Record<number, ReactNode> = {
    0: (
      <>
        <p>
          Ink & Thread brings no AI of its own. It needs one to write the story, and can use another to draw its pictures. A few pages set them up, with what we
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
        <p className="muted">Everything here is in Settings too, to change any time, and Settings → Guided setup brings these pages back.</p>
      </>
    ),
    [PROVIDER]: (
      <>
        <p>Where the Narrator, the AI that writes your story, comes from.</p>
        <p className="muted">
          Providers come in three kinds. A gateway such as OpenRouter or NanoGPT reaches models from many makers with one key, so you can try several. A maker's
          own service, such as Google AI Studio, offers only its own family of models. And Local / OpenAI server reaches an AI on your own computer, or any
          other service that speaks the common OpenAI-compatible standard.
        </p>
        {command && !saved.commandHere ? (
          <LockedCommand line={commandBox.line!} />
        ) : (
          <>
            <Picker
              label="Text provider"
              value={command ? "command" : textChoice}
              choices={narratorChoices(saved)}
              onChange={(provider) => {
                commandBox.pick(provider);
                if (provider === "command") return;
                // As in Settings: a provider switched to brings back its own model, and Local the last local server, and turns the command off.
                const lastLocal = Object.keys(saved.textProfiles).findLast((at) => !Object.values(TEXT_PROVIDERS).includes(at)) ?? "";
                const textBaseUrl = provider === "local" ? lastLocal : TEXT_PROVIDERS[provider];
                set({
                  textBaseUrl,
                  textCommand: [],
                  ...(saved.textProfiles[textBaseUrl] ?? { textModel: "", textHost: "" }),
                  ...(draft.reviewSameProvider && { reviewModel: "" }),
                });
              }}
            />
            <p className="muted">
              {
                {
                  openrouter:
                    "One account and key reach every model, the drawing ones too, and you pay only for what you use, with a choice of which provider serves the model. Sign up, add a few dollars of credit, then make a key and paste it below. It's shown only once, so keep a copy.",
                  google:
                    "A free key with a Google account, to try Ink & Thread. The free tier limits how many Turns a day you get, and Google may use what you send, your story among it, to improve its products.",
                  nanogpt:
                    "One account and key reach every model, the drawing ones too. Pay as you go, or subscribe for a weekly allowance on open models such as DeepSeek that stays the same price however much you play. NanoGPT picks the provider. Sign up, add a balance or subscribe, then make a key and paste it below.",
                  local:
                    "An AI on your own computer, or any other OpenAI-compatible server. Nothing leaves your computer, but a long story outgrows a 10 GB graphics card, so it suits short stories, privacy and trying things out. Ollama is at http://localhost:11434/v1, LM Studio at http://localhost:1234/v1.",
                  command: "A program you set up, such as a provider's own command-line tool, instead of a server.",
                }[command ? "command" : textChoice]
              }
            </p>
            {command ? (
              <CommandField line={commandBox.line!} onLine={commandBox.type} />
            ) : (
              <>
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
            )}
          </>
        )}
      </>
    ),
    [MODEL]: (
      <>
        {command ? (
          <p className="muted">A command has no model to choose here: set the model and its thinking in the command, if the program allows. Test it below.</p>
        ) : (
          <>
            <p className="muted">
              {/* The Guide and README name the same models, so change them together. */}
              {
                {
                  openrouter:
                    "We recommend DeepSeek V4.1 Flash (search “deepseek flash”): in our tests it wrote the better stories of the low-cost AIs we tried, for under half a cent a Turn.",
                  google: "We recommend a Gemini Flash model.",
                  nanogpt: "We recommend DeepSeek V4.1 Flash, though any model you like will do.",
                  local: "Choose the model your server runs. DeepSeek writes well if you can run it.",
                }[textChoice]
              }
            </p>
            <p className="muted bench-chart-hint">
              <BenchChartButton />
              How well each AI told our test stories, and what a Turn cost.
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
        <p>We recommend GPT-6 Luna (search “luna”) on Medium thinking. It is a closed model, so OpenAI sees what it is sent.</p>
        <ReviewSettings draft={draft} saved={saved} set={set} narratorModels={models} reviewKey={reviewKey} setReviewKey={setReviewKey} />
      </>
    ),
    [PICTURES]: (
      <>
        <p>Ink & Thread can draw the Cover, a portrait of each person and the scene as the story moves.</p>
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
            {sharesKey && (
              <label className="toggle">
                <input type="checkbox" checked={textKeyDraws} onChange={(e) => setUseTextKey(e.target.checked)} />
                Use the Narrator's key
              </label>
            )}
            {!textKeyDraws && (
              <label>
                Image API key
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder={saved.imageKeysFor.includes(draft.imageProvider) ? "Saved. Type a new key to replace it." : "None saved"}
                  value={imageKey}
                  onChange={(e) => setImageKey(e.target.value)}
                />
              </label>
            )}
            {saveHere}
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
              For a good graphics card. Ink & Thread draws a lot, the Cover, portraits, scenes and every redraw, and each costs money online but nothing here.
              We recommend FLUX.2 or Qwen Image 2.1, which keep faces the same from picture to picture. The <a href="#/guide/models">Reader's Guide</a> says how
              to install ComfyUI, and Advanced workflows are in Settings → Images.
            </p>
            <ProviderLinks provider="comfy" />
            {saveHere}
            <ComfySettings draft={draft} saved={saved} set={set} />
          </>
        )}
      </>
    ),
    [READING]: (
      <>
        <ReadingSamples
          value={draft}
          onChange={(change) => {
            set(change);
            applyLook({ ...draft, ...change });
          }}
        />
        {/* As in Settings, with more said, as a new player hasn't met Checks yet. */}
        <label className="toggle">
          <input type="checkbox" checked={draft.showChecks} onChange={(e) => set({ showChecks: e.target.checked })} />
          Show Checks
        </label>
        <p className="muted">
          When your character tries something that could fail, or someone reacts to what they do, the Narrator rolls hidden dice, and the story follows the
          result. On, a line under the reply shows how hard it was, the roll and the result. Off, the dice stay hidden and the story reads without them.
        </p>
      </>
    ),
    [READY]: (
      <>
        <p>{ready ? "Ink & Thread is ready." : "The story needs its Narrator set up first: go back to The storyteller."}</p>
        <dl className="test-stats">
          <dt>Narrator</dt>
          <dd>{saved.textCommand.length > 0 ? `Command, ${saved.textCommand[0]}` : `${textName(saved.textBaseUrl)}, ${saved.textModel || "no model"}`}</dd>
          <dt>Scribe</dt>
          <dd>{saved.reviewOtherModel && saved.reviewModel ? saved.reviewModel : "The Narrator's own"}</dd>
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
            {saved.fontSize} type, {saved.showChecks ? "Checks shown" : "dice hidden"}
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
