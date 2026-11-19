import { z } from "zod";
import { parseWorkflow } from "./comfy-workflow";
import { comfyModels, randomSeed } from "./comfyui";
import { chosenModels, drawSteps, localIsSetUp } from "./graph-builder";
import { imageResponse, parseBody, PromptRequest, routes, type ServerContext } from "./http";
import type { ImageAdapter } from "./image-adapter";
import { defaultLogLevel, errorFields, errorType, log, setLogLevel } from "./logger";
import { estimateTokens } from "./lore-activation";
import { OnlineImageProvider, reviewerSettings, type SettingsChange, SettingsUpdate } from "./settings-store";
import { textHosts, textModels } from "./text-provider";
import { ContentRefused, TextProviderFailed } from "./turn-engine";
import { GOOGLE_URL, NANOGPT_URL, OPENROUTER_URL, storyName, UNREADABLE_SAVE } from "./web/api";

// Only the online providers have a list. ComfyUI's models come from /settings/comfy-models.
const ImageModelsQuery = z.object({ provider: OnlineImageProvider });
const TextModelsQuery = z.strictObject({ for: z.enum(["review", "consistency"]).optional() });
const UsageQuery = z.strictObject({ by: z.enum(["day", "week", "month"]) });

/** `profiles` with each one's key taken out. */
const unkeyed = <T extends object>(profiles: Record<string, T>, key: keyof T) =>
  Object.fromEntries(Object.entries(profiles).map(([at, { [key]: _key, ...rest }]) => [at, rest])) as Record<string, Omit<T, typeof key>>;

// The image providers that also serve the Narrator, by its address, whose one key does both.
const SAME_SERVICE = { openrouter: OPENROUTER_URL, google: GOOGLE_URL, nanogpt: NANOGPT_URL };
// Setup's save can ask for the Narrator's key to draw with too.
const SettingsSave = SettingsUpdate.extend({ imageKeyFromText: z.boolean().optional() });

/** Settings and their tests. `local` is the ComfyUI adapter, and `workflow` how its last job went, which only the screen shows. */
export function settingsRoutes({ options, images, saves }: ServerContext, local: ImageAdapter, workflow: { problem: string }) {
  const { settings } = options;
  // An allowlist, so the API key can never reach a response.
  const publicSettings = () => {
    const {
      textBaseUrl,
      textModel,
      textRouting,
      textHost,
      textHostFallback,
      textApiKey,
      modelInstructions,
      imageInstructions,
      textMaxTokens,
      textReplyMinutes,
      textThinking,
      textThinkingTokens,
      pictureThinkingTokens,
      reviewOtherModel,
      reviewModel,
      reviewSameProvider,
      reviewBaseUrl,
      reviewApiKey,
      reviewThinking,
      consistencyEnabled,
      consistencyChatModel,
      consistencySameProvider,
      consistencyBaseUrl,
      consistencyApiKey,
      textRecentMessages,
      answerRejectWords,
      imageProvider,
      imageModel,
      imageApiKey,
      imagesEnabled,
      openNewImages,
      showChecks,
      drawScenes,
      updatePortraits,
      comfyUrl,
      comfyFamily,
      comfySdBase,
      imageResolution,
      comfyCheckpoint,
      comfyDiffusionModel,
      comfyTextEncoder,
      comfyVae,
      comfyLoras,
      comfySteps,
      comfyCfg,
      comfyDefaults,
      comfySampler,
      comfyScheduler,
      comfyFamilyPicks,
      comfyMode,
      comfyWorkflow,
      comfyFreeMemory,
      chatStyle,
      fontSize,
      theme,
      logLevel,
      storyInLog,
      textProfiles,
      imageProfiles,
    } = settings.read();
    return {
      textBaseUrl,
      textModel,
      textRouting,
      textHost,
      textHostFallback,
      hasTextApiKey: textApiKey !== "",
      // Each server's and provider's own settings, for the form to switch to, and where a key is filed, but never the keys.
      textProfiles: unkeyed(textProfiles, "textApiKey"),
      textKeysFor: Object.keys(textProfiles).filter((at) => textProfiles[at]?.textApiKey),
      modelInstructions,
      imageInstructions,
      textMaxTokens,
      textReplyMinutes,
      textThinking,
      textThinkingTokens,
      pictureThinkingTokens,
      reviewOtherModel,
      reviewModel,
      reviewSameProvider,
      reviewBaseUrl,
      hasReviewApiKey: reviewApiKey !== "",
      reviewThinking,
      consistencyEnabled,
      consistencyChatModel,
      consistencySameProvider,
      consistencyBaseUrl,
      hasConsistencyApiKey: consistencyApiKey !== "",
      textRecentMessages,
      answerRejectWords,
      imageProvider,
      imageModel,
      hasImageApiKey: imageApiKey !== "",
      imageProfiles: unkeyed(imageProfiles, "imageApiKey"),
      imageKeysFor: Object.keys(imageProfiles).filter((at) => imageProfiles[at]?.imageApiKey),
      imagesEnabled,
      openNewImages,
      showChecks,
      drawScenes,
      updatePortraits,
      imagesReady: images.ready(),
      comfyUrl,
      comfyFamily,
      comfySdBase,
      imageResolution,
      comfyCheckpoint,
      comfyDiffusionModel,
      comfyTextEncoder,
      comfyVae,
      comfyLoras,
      comfySteps,
      comfyCfg,
      comfyDefaults,
      comfySampler,
      comfyScheduler,
      comfyFamilyPicks,
      comfyMode,
      comfyWorkflow,
      comfyFreeMemory,
      workflowProblem: workflow.problem,
      chatStyle,
      fontSize,
      theme,
      logLevel: logLevel ?? null,
      defaultLogLevel: defaultLogLevel(),
      storyInLog,
      canQuit: !!options.quittable,
    };
  };

  return routes({
    "/settings": {
      GET: () => Response.json(publicSettings()),
      PATCH: async (req) => {
        const { imageKeyFromText, ...change } = await parseBody(req, SettingsSave);
        const current = settings.read();
        if (imageKeyFromText) {
          // Copied here, as the page never holds a stored key, and only to the image side of the same service it was entered for.
          const url = SAME_SERVICE[(change.imageProvider ?? current.imageProvider) as keyof typeof SAME_SERVICE];
          const key = url && current.textProfiles[url]?.textApiKey;
          if (!key) return Response.json({ error: "The Narrator has no saved key for this image provider." }, { status: 422 });
          change.imageApiKey = key;
          log.info("settings", "Image key from the Narrator", { provider: change.imageProvider ?? current.imageProvider });
        }
        const next = { ...current, ...change };
        // Only a workflow in use, as Settings hides the box otherwise, and the player couldn't see what to fix.
        if (next.imageProvider === "local" && next.comfyMode === "advanced") parseWorkflow(next.comfyWorkflow);
        settings.update(change);
        if (next.comfyWorkflow !== current.comfyWorkflow) workflow.problem = "";
        if (change.logLevel !== undefined) setLogLevel(change.logLevel);
        // Names only, as a value can be a key. The form sends every field, so only those that differ.
        const same = (field: keyof SettingsChange) => JSON.stringify(current[field] ?? null) === JSON.stringify(change[field] ?? null);
        log.info("settings", "Settings changed", () => ({ fields: (Object.keys(change) as (keyof SettingsChange)[]).filter((field) => !same(field)) }));
        return Response.json(publicSettings());
      },
    },
    // Only ever the saved server, so a key can't reach an address that is still being typed. `for=review` lists the reviewer's,
    // and `for=consistency` its own server's, which Settings asks for only when it has one.
    "/settings/text-models": {
      GET: async (req) => {
        const { for: whose } = TextModelsQuery.parse(Object.fromEntries(new URL(req.url).searchParams));
        const own = () => ({ ...settings.read(), textBaseUrl: settings.read().consistencyBaseUrl, textApiKey: settings.read().consistencyApiKey });
        const listed = whose === "review" ? reviewerSettings(settings) : whose === "consistency" ? { read: own } : settings;
        return Response.json({ models: await textModels(listed, req.signal) });
      },
    },
    // Public catalogs, so the provider the form shows now is asked, saved or not.
    "/settings/image-models": {
      GET: async (req) => {
        const { provider } = ImageModelsQuery.parse(Object.fromEntries(new URL(req.url).searchParams));
        return Response.json({ models: (await options.imageModels?.(provider, req.signal)) ?? [] });
      },
    },
    // Numbers and Settings values only, as `summary` allowlists its fields.
    "/settings/usage": {
      // startServer always gives one.
      GET: (req) => Response.json(options.usage!.summary(UsageQuery.parse(Object.fromEntries(new URL(req.url).searchParams)).by)),
    },
    // Counts only, with each story's title as Load Story shows it. A deleted story's counts stay in the file but aren't shown.
    "/settings/usage/narrator": {
      GET: () => {
        const titles = new Map(saves.list().map((save) => [save.id, "unreadable" in save ? UNREADABLE_SAVE : storyName(save)]));
        return Response.json({
          stories: options
            .usage!.narrator()
            .filter(({ save }) => titles.has(save))
            .map(({ save, ...counts }) => ({ save, title: titles.get(save)!, ...counts })),
        });
      },
    },
    "/settings/text-hosts": {
      GET: async (req) => Response.json({ hosts: await textHosts(settings, new URL(req.url).searchParams.get("model") ?? "", req.signal) }),
    },
    // The prompt and Model Instructions alone, with no schema, so a failure points at the model and not at the app.
    "/settings/text-test": {
      POST: async (req) => {
        const { prompt } = await parseBody(req, PromptRequest);
        const started = performance.now();
        const elapsed = () => (performance.now() - started) / 1000;
        let firstSeconds: number | undefined;
        try {
          const onText = () => (firstSeconds ??= elapsed());
          const { modelInstructions: content } = settings.read();
          const system = content.trim() ? [{ role: "system" as const, content }] : [];
          const reply = await options.textProvider([...system, { role: "user", content: prompt }], {
            call: "settingsTest",
            onText,
            signal: req.signal,
          });
          const seconds = elapsed();
          return Response.json({
            reply,
            seconds,
            firstSeconds: firstSeconds ?? seconds,
            tokens: estimateTokens(reply),
            model: settings.read().textModel,
          });
        } catch (error) {
          if (error instanceof ContentRefused) log.warning("text", "The model refused the test", errorType(error));
          else log.error("text", "The text test failed", errorFields(error));
          if (error instanceof ContentRefused) return Response.json({ error: "The model refused this prompt." }, { status: 422 });
          const message = error instanceof TextProviderFailed ? error.message : "The Text Provider request failed";
          return Response.json({ error: message }, { status: 502 });
        }
      },
    },
    // Only ever the saved address, never one still being typed.
    "/settings/comfy-models": {
      GET: async (req) => Response.json(await comfyModels(settings, req.signal)),
    },
    // Draws straight to the client, so a test image reaches no Save and no session count.
    "/settings/comfy-test": {
      POST: async (req) => {
        const { prompt } = await parseBody(req, PromptRequest);
        const choices = settings.read();
        if (!localIsSetUp(choices)) return Response.json({ error: "Choose your models and save first." }, { status: 422 });
        try {
          const seed = randomSeed();
          const started = performance.now();
          const payload = { prompt, aspect_ratio: "16:9", reference_images: [], style_preset: "", seed };
          const image = imageResponse((await local(payload, req.signal)) as Uint8Array<ArrayBuffer>);
          // A workflow names its own model and steps, and may ignore the seed.
          const simple = choices.comfyMode === "simple" && { model: chosenModels(choices)[0], steps: drawSteps(choices), seed };
          const stats = { seconds: (performance.now() - started) / 1000, ...simple };
          // Encoded because a model's filename may not be valid in a header.
          image.headers.set("X-Draw-Stats", encodeURIComponent(JSON.stringify(stats)));
          return image;
        } catch (error) {
          log.error("images", "The image test failed", errorType(error));
          // The adapter's messages are written to be shown, but a failed connection is Bun's own, which has a `code`.
          const { code, message } = error as Error & { code?: string };
          return Response.json({ error: code ? "ComfyUI can't be reached at this address. Make sure it's running." : message }, { status: 502 });
        }
      },
    },
  });
}
