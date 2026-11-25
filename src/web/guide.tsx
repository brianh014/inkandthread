import { type ReactNode, useState } from "react";
import { endTips } from "./api";
import { BenchChart } from "./bench-chart";
import {
  AskIcon,
  ChapterIcon,
  ChartIcon,
  ChoicesIcon,
  ContinueIcon,
  DecideIcon,
  DeleteIcon,
  DrawIcon,
  DieIcon,
  DuplicateIcon,
  StartOverIcon,
  EditIcon,
  ExportIcon,
  FullScreenIcon,
  RegenerateIcon,
  RenameIcon,
  RevertIcon,
  RewriteIcon,
  SendIcon,
  StopIcon,
  UploadIcon,
} from "./icons";
import { DISCORD_URL, DONATE_URL, GITHUB_URL, MenuRibbon, Sheet } from "./menu";
import { QUIET_TURNS } from "./usage";

/** The Reader's Guide: what Ink & Thread is and how to use every part of it, one section at a time, kept in the URL hash. */

/** What a player takes on with a command as their AI, in full, as Settings shows only a line of it. */
export const CommandCaveats = () => (
  <ul>
    <li>
      <b>Terms</b>: the provider's terms apply, and some don't allow a subscription to be used by another app. That's your call.
    </li>
    <li>
      <b>Content rules</b>: a subscription brings its company's content rules into your story.
    </li>
    <li>
      <b>Limits</b>: one Turn is several calls (the Narrator, the Scribe, the world moving on, picture prompts). A subscription's limits can run out mid-story,
      and play stops until they reset.
    </li>
    <li>
      <b>Speed</b>: each call starts the program again, which adds time before every reply.
    </li>
    <li>
      <b>No caching or costs</b>: prompt caching is up to the program, and Ink & Thread can't see tokens or cost, so Usage counts calls only.
    </li>
    <li>
      <b>No Thinking setting</b>: Thinking does nothing; set it in the command if the program allows.
    </li>
  </ul>
);

/** A tool as it looks on screen: its icon, then its name. */
const tool = (icon: ReactNode, name: string) => (
  <b className="guide-tool">
    {icon}
    {name}
  </b>
);

const link = (slug: string, text: string) => <a href={`#/guide/${slug}`}>{text}</a>;

const SECTIONS: { slug: string; name: string; body: ReactNode }[] = [
  {
    slug: "start",
    name: "Getting started",
    body: (
      <>
        <p>
          Ink & Thread is a choose-your-own visual novel that is written as you play. You make a world and a character, your <b>PC</b>, then act and speak only
          as them. An AI plays the <b>Narrator</b>: it tells the story, voices everyone else, keeps track of the world and quietly decides whether what you try
          works. The world it builds has secret Plot Threads of its own, so the story can turn in ways you don't expect. An image AI draws the Cover, portraits
          and scenes as you go.
        </p>
        <p>Ink & Thread runs on your own computer. It brings no AI of its own: you connect the ones you choose, and your stories stay on your computer.</p>
        <h3>Your first story</h3>
        <ol>
          <li>
            Choose <b>Setup Ink & Thread</b> on the Menu. Until the AI that writes your story is set up, it takes the place of New Story and Load Story. Its
            pages go one at a time, with what to pick beside each: the AI that writes your story, its key and model, the Scribe, a second AI that keeps the
            story's record, pictures or text only, and how the story reads. Only the first AI is needed; the rest can be skipped. Beside the model,{" "}
            {tool(ChartIcon, "How the AIs compare")} shows how each AI told our test stories and what a Turn cost. {link("models", "Choosing your AI")} says
            more about which to pick.
          </li>
          <li>
            When it's done, choose <b>Begin a New Story</b>. Write as much or as little as you like, or press {tool(DecideIcon, "Pick for me")} and let the
            Narrator fill it in. See {link("new", "Making a story")}.
          </li>
          <li>Read the Opening, then type what your PC does or says and send it. See {link("play", "Playing")}.</li>
        </ol>
        <p>Everything saves as you go. There is no save button: come back any time with Load Story.</p>
      </>
    ),
  },
  {
    slug: "models",
    name: "Choosing your AI",
    body: (
      <>
        <h3>The story: an online AI is best</h3>
        <p>
          The Narrator needs a capable AI. Each Turn sends it the newest Messages in full, plus the world, the Journal and the Old Memories, so a long story's
          prompt grows past 30,000 tokens. A large online AI takes all of that, keeps the story straight and costs pennies a Turn.
        </p>
        <p>
          OpenRouter and NanoGPT each reach hundreds of AIs, the drawing ones too, with one key. Pick whichever suits you. With either, choose it in{" "}
          <b>Settings → Text</b>, paste the key into <b>Text API key</b>, choose a <b>Text model</b> and press <b>Test text</b>. We recommend DeepSeek V4.1
          Flash (<code>deepseek/deepseek-v4.1-flash-1017</code> on OpenRouter): in our tests it wrote the better stories of the low-cost AIs we tried, for under
          half a cent a Turn.
        </p>
        <ul>
          <li>
            <b>OpenRouter</b>: you pay for what you use, a few cents a Turn. Sign up at <code>openrouter.ai</code>, open <b>Credits</b> and add a few dollars,
            then open <b>Keys</b>, choose <b>Create Key</b> and copy the key. It's shown only once, so keep a copy somewhere safe. You can also choose which of
            its providers serves the AI, and how it routes. The same AI can write noticeably worse on one provider than another, as some run a smaller copy of
            it to save cost or handle a long story less well, and OpenRouter may switch providers between Turns. If replies suddenly turn odd, such as speaking
            for your character or losing track of the scene, choose one provider under <b>Provider</b>. Staying on one provider also keeps its prompt cache,
            which makes each Turn cheaper.
          </li>
          <li>
            <b>NanoGPT</b>: pay as you go, or a monthly subscription with a weekly allowance for open AIs such as DeepSeek, enough for about 200 Turns a day,
            plus some pictures a day, so the price stays the same however much you play. Sign up at <code>nano-gpt.com</code>, add a balance or subscribe, then
            create an API key. NanoGPT picks which provider serves the AI, and on the subscription you can't choose one.
          </li>
          <li>
            <b>Google AI Studio</b>, which has a free key: sign in at <code>aistudio.google.com</code> with a Google account and choose <b>Get API key</b>.
            Choose <b>Google AI Studio</b> in <b>Settings → Text</b>, paste the key, save, then pick a Gemini Flash model. On the free tier Google may use what
            you send, your story among it, to improve its products, and it limits how many Turns a day you get.
          </li>
          <li>
            <b>Any other OpenAI-compatible service</b>, such as DeepInfra: choose <b>Local / OpenAI server</b>, give its address (for DeepInfra,{" "}
            <code>https://api.deepinfra.com/v1/openai</code>), save, then pick the model and enter its key.
          </li>
          <li>
            <b>An AI on your own computer</b>, with Ollama (<code>http://localhost:11434/v1</code>), LM Studio (<code>http://localhost:1234/v1</code>) or
            another OpenAI-compatible server: choose <b>Local / OpenAI server</b>. It suits short stories, privacy and trying things out. A 10 GB graphics card
            holds a model of about 12B with a 16,000-token context, so the Narrator sees much less of a long story. Set <b>Longest reply, in tokens</b> to about
            3000 and <b>Recent Messages</b> to 40, and raise the context length in the server itself (Ollama's default is small and cuts the prompt without
            saying so).
          </li>
        </ul>
        <h3>How the AIs compare</h3>
        <p>
          Ink & Thread's makers play the same stories on each AI and judge how well it tells them: whether Choices matter, the hidden plots surprise, people
          stay true to themselves, and more. Each dot is one AI, set higher when it told the stories better and further left when it cost less a Turn. Pick a
          score or a story to see where each one is strong, and press {tool(FullScreenIcon, "Full screen")} to see it larger. Every story was played with the
          same setup otherwise, pictures drawn on ComfyUI.
        </p>
        <BenchChart />
        <h3>A command as your AI</h3>
        <p>
          Instead of a server, the story can run on a program you set up, such as a provider's own command-line tool. Ink & Thread sends it the prompt as text
          and reads its reply. In <b>Settings → Text</b>, choose <b>Command</b> as the <b>Text provider</b> and type the program and its arguments, such as{" "}
          <code>claude -p --output-format text</code>, quoting any argument with spaces. The program runs with no shell, in an empty folder, and must print its
          reply and nothing else. As it runs a program on your computer, only Settings opened on that computer, at <code>127.0.0.1</code> or{" "}
          <code>localhost</code>, can set or change it; on a phone or another computer it's shown but locked. An online AI as above is still the way we
          recommend.
        </p>
        <CommandCaveats />
        <h3>Pictures: your own ComfyUI is best</h3>
        <p>
          Ink & Thread draws a lot: the Cover, a portrait for each person, a scene picture whenever the scene changes, pictures you ask for and every redraw. On
          a paid image service each one costs money; on your own ComfyUI they are free.
        </p>
        <ul>
          <li>
            <b>Local (ComfyUI)</b>: give ComfyUI's address and choose its models. In Simple Mode, FLUX.2 or Qwen Image keep faces the same from picture to
            picture, as they can use the portraits; SD 1.5 and SDXL can't. If an AI on your own computer shares the graphics card, turn on{" "}
            <b>Free GPU memory after each picture</b>.
          </li>
          <li>
            <b>OpenRouter</b>: for when you have no graphics card for ComfyUI. Paste the same key you use for the story into <b>Image API key</b> and choose an
            image AI: try Seedream 5.5, or Nano Banana 2.1 for a little better quality.
          </li>
          <li>
            <b>Google AI Studio</b>: the same key as for the story draws with Nano Banana, but pictures aren't free, so turn on billing for it in AI Studio
            first.
          </li>
          <li>
            <b>NanoGPT</b>: the same key as for the story draws with any of its image AIs, Seedream and Nano Banana among them. NanoGPT says the services it
            sends pictures to may keep the prompts and pictures.
          </li>
          <li>
            <b>Wiro</b>: the same, with a key from{" "}
            <a href="https://wiro.ai" target="_blank" rel="noreferrer">
              wiro.ai
            </a>
            . Set its project to <b>API key only</b>, and choose an image AI from the list, such as bytedance/seedream-5-5.
          </li>
        </ul>
        <p>
          You can turn pictures off at any time with <b>Create new images</b>, and only draw the ones you ask for by turning off <b>Draw scene pictures</b>.
        </p>
      </>
    ),
  },
  {
    slug: "new",
    name: "Making a story",
    body: (
      <>
        <p>New Story has three steps. What you write stays in this browser tab, so a trip to Settings or a reload doesn't lose it.</p>
        <h3>1. World and Characters</h3>
        <ul>
          <li>
            <b>Theme</b>: the kind of story, such as High Fantasy, Cyberpunk or Horror, or your own.
          </li>
          <li>
            <b>Tone</b>: how the story is told, such as Wry, Whimsical or Grim, or your own. The world's own leaves it to the world. It changes only the
            telling, never what happens. You can change it later in the Journal.
          </li>
          <li>
            <b>World Brief</b>: your description of the world. A line is enough; more gives you more say. You can change it later in the Journal.
          </li>
          <li>
            <b>Your Character</b>: your PC's name, who they are and what they look like.
          </li>
          <li>
            <b>Important Characters</b>: up to ten people you want in the story, each with a name and a description. The world is built around them, and each
            gets a portrait.
          </li>
          <li>
            <b>Starting Hook</b>: the situation the story opens on. Turn it off and your PC simply starts in the world.
          </li>
        </ul>
        <p>
          Each box has {tool(DecideIcon, "Write")} when it's empty and {tool(DecideIcon, "Enhance")} when it isn't: the Narrator writes it or builds on your
          words. Once a box holds something, {tool(RewriteIcon, "Nudge")} has the Narrator change one thing you name, such as "a different power", and keep the
          rest. <b>Undo</b> puts your words back. {tool(DecideIcon, "Pick for me")} fills every empty box at once and leaves the ones you wrote, and never
          touches Important Characters.
        </p>
        <h3>2. Art</h3>
        <p>
          Choose an <b>Art Style</b> for every picture in the story, or describe your own. Then draw your PC's portrait, each Important Character's and the
          Cover, or leave any of them to be drawn when the story begins. Each picture has:
        </p>
        <ul>
          <li>
            <b>Draw</b> or {tool(EditIcon, "Redraw")}: draw it from its prompt.
          </li>
          <li>{tool(RegenerateIcon, "Redo")}: write a new prompt from your choices as they are now, and draw it.</li>
          <li>{tool(RewriteIcon, "Nudge")}: draw it again with a few words of your own, such as "smiling".</li>
          <li>{tool(UploadIcon, "Upload")}: use a picture of your own (PNG, JPEG or WebP, up to 10 MB).</li>
        </ul>
        <h3>3. Your World</h3>
        <p>
          The Narrator builds the world: a spoiler-free overview of what your PC would know, while the rest stays secret for the story to reveal. Read it, then{" "}
          <b>Begin</b>, or <b>Regenerate</b> for a different world from the same choices. Your PC and pictures stay. Going back to change your choices discards
          this world.
        </p>
      </>
    ),
  },
  {
    slug: "play",
    name: "Playing",
    body: (
      <>
        <p>
          Each <b>Turn</b> is your move and the Narrator's reply, which appears as it's written. Write as your PC: what they do, what they say, or both. The
          Narrator plays everyone and everything else.
        </p>
        <h3>Choices</h3>
        <p>
          Every reply comes with three things your PC might do; pick one to send it, or type your own in the box under them. The {tool(ChoicesIcon, "Choices")}{" "}
          button hides them, so you type every move, and shows them again, in every story. Decide for me and Enhance are there while the Choices are hidden.
        </p>
        <h3>The tools by the box</h3>
        <ul>
          <li>
            {tool(SendIcon, "Send")}, or Enter: send your move. Shift+Enter starts a new line. {tool(StopIcon, "Stop")} halts a reply while it's being written.
          </li>
          <li>{tool(ContinueIcon, "Continue")}: send nothing and let the people around your PC carry the moment on, without skipping ahead.</li>
          <li>
            {tool(DecideIcon, "Decide for me")} (with the box empty): the Narrator suggests a move for your PC, for you to send or change. With words in the box
            it becomes {tool(DecideIcon, "Enhance")}, which polishes what you wrote; <b>Undo</b> puts your words back.
          </li>
          <li>
            {tool(AskIcon, "Ask the Narrator")}: an out-of-character question, like asking a game master, such as "Would my character know this lord?" It is
            answered only from what your PC would know, changes nothing, and is forgotten.
          </li>
          <li>{tool(DrawIcon, "Draw a picture")}: describe a picture and it's drawn from your words and the recent story.</li>
          <li>
            {tool(RewriteIcon, "Tell Narrator what to change")}: change the world in your own words. See {link("fix", "Changing the story")}.
          </li>
        </ul>
        <p>The first time you read a story, tips point at each of these tools in turn. To see them again:</p>
        <ShowTipsAgain />
        <h3>Luck and risk</h3>
        <p>
          An AI tends to be agreeable: left to itself, it lets nearly everything your PC tries work, and a story where nothing can fail soon goes flat. So Ink &
          Thread brings in real chance. When your PC tries something that could fail, the Narrator sets how hard it is before anyone knows the outcome, then a
          hidden die is rolled, and the Narrator writes what the roll decides.
        </p>
        <p>
          You never see the roll, only how things turn out. A bold plan can go wrong, a long shot can come off, and a well-chosen move gives you better odds.
        </p>
        <h3>Chapters</h3>
        <p>
          The story is divided into <b>Chapters</b>, which you read as a whole in the Journal. Only you end one: use {tool(ChapterIcon, "End the chapter here")}{" "}
          under the latest Message, or accept when the Narrator suggests a good place to stop. The next Chapter begins at once.
        </p>
        <h3>Leaving</h3>
        <p>
          You can go to the Menu, close the tab, or with the Server open the story on another device, at any time. A reply that's being written carries on and
          is there when you come back.
        </p>
      </>
    ),
  },
  {
    slug: "fix",
    name: "Changing the story",
    body: (
      <>
        <p>Nothing is final. The tools under a Message let you change what happened.</p>
        <h3>The latest reply</h3>
        <ul>
          <li>{tool(RewriteIcon, "Rewrite")}: tell the Narrator what to change, such as "she wouldn't give up that easily", and it writes the reply again.</li>
          <li>{tool(EditIcon, "Edit")}: change the words yourself. The Narrator brings the world in line with your version and writes nothing new.</li>
          <li>
            {tool(RegenerateIcon, "Regenerate")}: a fresh reply to the same move, with no guidance. {tool(RegenerateIcon, "Regenerate with Choices")} writes it
            again with three Choices, when a reply came without them.
          </li>
        </ul>
        <h3>Earlier Messages</h3>
        <ul>
          <li>
            {tool(RevertIcon, "Revert to here")}: go back to that Message and delete everything after it, for good. Revert to your own words and the AI answers
            them again. What you told the Narrator to change after that Message is kept: it's made again on the story as it then stands.
          </li>
          <li>
            {tool(EditIcon, "Edit and replay from here")} (on your own Messages): change what you wrote and play the story again from there. Everything after it
            goes, apart from what you told the Narrator to change, which is made again as Revert does.
          </li>
          <li>
            {tool(DuplicateIcon, "Duplicate from here")}: keep this story as it is, and carry on from that Message in a new Save. This is how you try another
            path.
          </li>
          <li>
            {tool(DieIcon, "Check")} (with <b>Show Checks</b> on): when what your PC tried could go either way, a hidden roll of a twenty-sided die decided it.
            A line under the reply says how hard it was, the roll and the result.
          </li>
        </ul>
        <h3>Changing the world</h3>
        <p>
          By the box, or in the Journal, {tool(RewriteIcon, "Tell Narrator what to change")} takes a change in your own words, such as "The king has a twin" or
          "My PC lost the sword in the river". The Narrator updates the world's secrets and the Journal to match, and the story carries on from there.
        </p>
      </>
    ),
  },
  {
    slug: "journal",
    name: "The Journal",
    body: (
      <>
        <p>
          The Journal is what your PC knows, kept up to date by the AI as you play. It never holds the world's secrets. You can change its text with{" "}
          {tool(EditIcon, "Edit")}, and your edit lasts unless you Revert to before it.
        </p>
        <ul>
          <li>
            <b>Story Time</b>: the date and time of day in the story, in the world's own calendar. Correct it if it's wrong.
          </li>
          <li>
            <b>World Brief</b>: your description of the world, which you can change.
          </li>
          <li>
            <b>Tone</b>: how the story is told, which you can change. The next reply takes it up.
          </li>
          <li>
            <b>Story Summary</b> and <b>Recent summary</b>: the story so far, and what just happened.
          </li>
          <li>
            <b>Loose Ends</b>: what your PC knows is still unsettled, such as promises, plans and open questions. Add, change or remove them. Removing one only
            tells the Narrator to stop pressing it: it still happened. When many are open, the AI clears a few the story has moved past.
          </li>
          <li>
            <b>What your PC knows</b>: the facts your PC has learned so far. Add, change or remove them, and the Narrator takes what you write as true. When
            there are many, the AI clears a few that repeat another or are no longer so.
          </li>
          <li>
            <b>Characters</b>: everyone your PC has met, with what your PC knows of them. {tool(RenameIcon, "Rename")} changes a name everywhere in the story.
          </li>
          <li>
            <b>Old Memories</b>: short accounts of older parts of the story. The Narrator only sees the newest Messages in full, and these are how it remembers
            the rest. Fix one if it gets something wrong.
          </li>
          <li>
            <b>Chapters</b>: read the story a Chapter at a time, and rename them.
          </li>
        </ul>
      </>
    ),
  },
  {
    slug: "pictures",
    name: "Pictures and the Gallery",
    body: (
      <>
        <p>With an image AI set up, pictures come by themselves:</p>
        <ul>
          <li>
            <b>Scene pictures</b> when the scene changes, shown in the story beside the reply.
          </li>
          <li>
            <b>Portraits</b> of each person your PC meets, and of your PC. With <b>Update portraits as the story goes</b> on, a portrait is redrawn when
            someone's look changes in a way that lasts, such as new clothes or a haircut, keeping their face.
          </li>
          <li>
            <b>Pictures you ask for</b> with Draw a picture.
          </li>
        </ul>
        <p>
          Every picture in a story is in its <b>Gallery</b>: the Cover, the Characters and the Scenes. Open a picture to read and change the prompt it was drawn
          from, then:
        </p>
        <ul>
          <li>{tool(EditIcon, "Redraw")}: draw it again from its prompt.</li>
          <li>{tool(RegenerateIcon, "Update")} (the Cover and portraits): write a new prompt from the story as it stands, and draw it.</li>
          <li>{tool(RewriteIcon, "Nudge")} (the Cover and portraits): draw it again with a few words of your own.</li>
          <li>{tool(UploadIcon, "Upload")} (the Cover and portraits): replace it with a picture of your own.</li>
          <li>{tool(DeleteIcon, "Delete")} (scene pictures only): it's gone for good, and a Revert doesn't bring it back.</li>
        </ul>
        <p>Change a story's Art Style in Settings while the story is open. Pictures already drawn keep theirs until you redraw them.</p>
      </>
    ),
  },
  {
    slug: "saves",
    name: "Saves",
    body: (
      <>
        <p>
          Each story is one Save, which saves itself after every Turn and every change. <b>Load Story</b> lists them, and from there you can:
        </p>
        <ul>
          <li>{tool(DuplicateIcon, "Duplicate")}: copy a Save, to branch a story or keep a backup before a risky move.</li>
          <li>
            {tool(StartOverIcon, "Start Over")}: begin a new story from this one's first step, its world, PC and Important Characters as the story began, all
            for you to change. Nothing played and no pictures carry over, and it replaces any story you were setting up.
          </li>
          <li>{tool(ExportIcon, "Export")}: download a Save as one file, pictures and all, to back it up or move it to another computer.</li>
          <li>
            <b>Import a Save</b>: bring an exported Save back in.
          </li>
          <li>{tool(DeleteIcon, "Delete")}: remove a Save for good.</li>
        </ul>
        <h3>Where your files are</h3>
        <p>
          Saves, Settings and logs are kept beside the program on Windows and Linux, in the folder you unpacked Ink & Thread into, and in{" "}
          <code>~/Library/Application Support/Ink & Thread</code> on a Mac. The <code>Saves</code> folder holds one file per story. Copy the folder to back
          everything up.
        </p>
      </>
    ),
  },
  {
    slug: "settings",
    name: "Settings",
    body: (
      <>
        <p>Settings apply to every story, except This Story, which appears when you open Settings from inside a story.</p>
        <h3>Text</h3>
        <ul>
          <li>
            <b>Text provider, Server address, Text API key, Text model</b>: where your Narrator is. With OpenRouter, <b>Provider</b> and <b>Routing</b> choose
            who serves the model. See {link("models", "Choosing your AI")}.
          </li>
          <li>
            <b>Thinking</b> (OpenRouter, NanoGPT and Google AI Studio): how long an AI that thinks before it writes may think. Lower is quicker and cheaper,
            though some AIs ignore it. On High, some AIs think past <b>Longest thinking</b>, and the reply is then stopped and asked again, which can fail every
            try: use Medium, or raise <b>Longest thinking</b>.
          </li>
          <li>
            Each provider keeps its own key, model and settings, so switching back brings them back. Where a provider lists its models, choose{" "}
            <b>Type a model name…</b> at the end of the list for one it leaves out, and {tool(ChoicesIcon, "Choose from the list")} to go back.
          </li>
          <li>
            <b>Extra Narrator Instructions</b>: your own guidance for the Narrator in every story, such as "Keep replies short" or "No romance".
          </li>
          <li>
            <b>Scribe</b>: after every reply, the Scribe keeps the story's record straight: where you are, who's there, what you wear and carry, what people
            have learned, and the time, so the next reply starts from what's true. It also looks over your new world, and any change to it, for contradictions
            and plot holes, and quietly fixes them, keeping its secrets from you. It works after the reply shows, so you don't wait on it. Tick{" "}
            <b>Use another model as the Scribe</b> to have a different AI do it: we recommend one from another family than the Narrator's, at least as smart, on
            Medium thinking, such as GPT-6 Luna. Its calls are small, so a smart one costs little, but a closed AI like that one sends what it reads to its
            maker. It uses the Narrator's provider unless you untick <b>Same provider as the Narrator</b> and give it its own. Its calls show in Usage under its
            own model. <b>Scribe thinking</b> lets it think harder, or less, than the story. On High, some AIs think past <b>Longest thinking</b>, and its work
            is then skipped.
          </li>
          <li>
            <b>Longest reply, in tokens</b> and <b>in minutes</b>: limits on one reply.
          </li>
          <li>
            <b>Longest thinking, in tokens</b>, for the story and for a picture's prompt: an AI that thinks past it is stopped and asked again. Google AI Studio
            keeps its thinking to itself, so these can't stop it there.
          </li>
          <li>
            <b>Recent Messages sent to the Narrator</b>: how many of the newest Messages it reads in full. More remembers more but costs more; older ones are
            remembered through Old Memories.
          </li>
          <li>
            <b>Longest Question answer, in words</b>: for Ask the Narrator.
          </li>
          <li>
            <b>Test text</b>: sends a short prompt to check the AI works. A paid provider may charge for it.
          </li>
        </ul>
        <h3>Images</h3>
        <ul>
          <li>
            <b>Create new images</b>: turn drawing on or off. Pictures you have stay.
          </li>
          <li>
            <b>Open new pictures in the story</b>: show new pictures open, or folded away.
          </li>
          <li>
            <b>Draw scene pictures</b> and <b>Update portraits as the story goes</b>: which pictures come by themselves.
          </li>
          <li>
            <b>Extra Image Instructions</b>: your own guidance for every picture.
          </li>
          <li>
            <b>Image provider</b>, its models and <b>Resolution</b>, and <b>Test image</b>. With ComfyUI, <b>Free GPU memory after each picture</b> lets other
            programs use the graphics card.
          </li>
        </ul>
        <h3>Reading</h3>
        <ul>
          <li>
            <b>Chat style</b>: how the story reads: Prose, Script or Bubbles, each shown as a few lines of story.
          </li>
          <li>
            <b>Light or dark</b>: light, dark, or matching this device.
          </li>
          <li>
            <b>Font size</b>: small, medium or large.
          </li>
          <li>
            <b>Show Checks</b>: a line under each reply where a roll decided how something went. Off by default, so the story reads without them.
          </li>
          <li>
            <b>Show Choices</b>: the three Choices after each reply, the same as the {tool(ChoicesIcon, "Choices")} button. On by default.
          </li>
        </ul>
        <h3>Usage</h3>
        <p>
          What you've asked of the AI lately: the totals, then a bar for each day, week or month, its parts the models used, text and pictures apart.{" "}
          <b>Show</b> switches the bars between requests, tokens and cost; point at a bar for its numbers, or choose <b>Show as a table</b>. Cost is what the
          provider reported, so it shows a dash where the provider reports none, such as ComfyUI, and ≥ where only some requests did. Nothing of your story is
          kept.
        </p>
        <h3>This Story</h3>
        <p>This story's Art Style.</p> <h3>Updates</h3>
        <p>
          The version you have, <b>Check now</b> to look for a new one, and <b>Install</b> when there is one. See {link("updates", "Updates")}.
        </p>
        <h3>Advanced</h3>
        <p>
          <b>Log Level</b>: how much goes in the log in the <code>logs</code> folder. By default it notes everything you and the AI do, and what came of it.
          Raise it to Verbose to trace a problem. The log never holds your keys, and holds your story's text only with Story in log on.
        </p>
        <p>
          <b>Story in log</b>: also writes everything sent to the AI and every reply, picture prompts too, story text included, to the log. It's only needed for
          advanced debugging, so leave it off otherwise, and turn it off before you share the log.
        </p>
        <p>
          <b>Narrator</b>: how often the AI used its tools in each story, such as Checks and moving story time. A note names a story after {QUIET_TURNS} Turns
          without either. If it's low, try another AI and compare.
        </p>
        <h3>Guided setup</h3>
        <p>
          Walks through the main settings again a page at a time, starting from what you chose, as <b>Setup Ink & Thread</b> did the first time. Each page's{" "}
          <b>Next</b> saves only that page, so leaving halfway loses nothing.
        </p>
      </>
    ),
  },
  {
    slug: "devices",
    name: "Other devices",
    body: (
      <>
        <p>
          The <b>Ink & Thread</b> download is for one computer: it opens in your browser and only that computer can reach it. Choose <b>Quit</b> on the Menu to
          close it, or it closes by itself a few minutes after its last page.
        </p>
        <p>
          The <b>Ink & Thread Server</b> download serves your whole home network, so you can play from a phone or tablet. Start it, then browse to one of the
          addresses it shows, such as <code>http://192.168.1.20:4600/</code>. It keeps running until you close its window.
        </p>
        <p>
          <b>The Server has no accounts.</b> Anyone who can reach it can play, change Settings and spend your saved keys. Keep it on a network you trust.
        </p>
      </>
    ),
  },
  {
    slug: "updates",
    name: "Updates",
    body: (
      <>
        <p>
          When a new version is out, a notice says so at the top of whatever screen you're on. Press <b>Install</b>: Ink & Thread downloads it, restarts and
          comes back to the same page. Your stories and Settings stay as they are. If the new version won't start, the old one comes back. Press × to put it
          off, and the notice stays away until the next version.
        </p>
        <p>
          To check, Ink & Thread asks GitHub for the newest release every few hours. That is the only thing it sends anywhere besides your AI.{" "}
          <b>Settings → Updates</b> shows the version you have, checks at once with <b>Check now</b>, and offers Install too.
        </p>
        <p>
          If you run Ink & Thread from its source code, update with <code>git pull</code> and <code>bun install</code> instead.
        </p>
      </>
    ),
  },
  {
    slug: "help",
    name: "Questions and problems",
    body: (
      <>
        <h3>What does it cost?</h3>
        <p>
          Ink & Thread is free. You pay your text and image providers for what you use, usually pennies a Turn for text. Pictures on ComfyUI are free; on a paid
          service each one costs. Your provider's site shows what you've spent.
        </p>
        <h3>Who sees my story?</h3>
        <p>
          Your stories stay on your computer. Each Turn sends the story to the AI you chose, and picture prompts to your image AI. With AI on your own computer,
          nothing leaves your computer at all.
        </p>
        <h3>A Turn failed</h3>
        <p>
          The error says why, and your move stays in the box to send again. Check your key and credit with the provider, and press Test text in Settings. An AI
          that refuses some content says so: Rewrite or change your move, or choose a different AI. Some AIs won't write how a roll turned out, and send back
          something that isn't a story; after three tries Ink & Thread tells you its content rules blocked it and saves nothing.
        </p>
        <h3>Replies are slow, or cut off</h3>
        <p>
          An AI on your own computer can take a minute a Turn. Raise <b>Longest reply, in tokens</b> if replies end early, or <b>in minutes</b> if a slow AI
          times out. If a reply sometimes takes minutes and then fails, the AI may be stuck thinking: lower <b>Thinking</b> or <b>Longest thinking</b>.
        </p>
        <h3>The Narrator forgot something</h3>
        <p>
          It reads only the newest Messages in full, and remembers the rest through Old Memories, the summaries and the Journal. Correct those in the Journal,
          or tell it with Tell Narrator what to change. A bigger <b>Recent Messages</b> helps, at more cost per Turn.
        </p>
        <h3>No pictures appear</h3>
        <p>
          Check <b>Create new images</b> is on and press <b>Test image</b> in Settings. For ComfyUI, make sure it is running, and that the models you chose are
          still there. Scene pictures come only when the scene changes; use Draw a picture for more.
        </p>
        <h3>Windows or macOS won't open it</h3>
        <p>
          The downloads aren't signed yet. On Windows choose <b>More info</b>, then <b>Run anyway</b>. On a Mac, open{" "}
          <b>System Settings → Privacy &amp; Security</b> and choose <b>Open Anyway</b> beside Ink & Thread.
        </p>
        <h3>Something else</h3>
        <p>
          Report it on{" "}
          <a href={`${GITHUB_URL}/issues`} target="_blank" rel="noreferrer">
            GitHub
          </a>
          , with what you did and what happened, or ask on the{" "}
          <a href={DISCORD_URL} target="_blank" rel="noreferrer">
            Discord
          </a>
          . The Discord and GitHub icons at the bottom of the Menu open them too. The log in the <code>logs</code> folder helps, and holds no keys, and no story
          text unless Story in log is on.
        </p>
        <h3>Supporting Ink & Thread</h3>
        <p>
          Ink & Thread is free. If you'd like to help it grow, <b>Support Ink & Thread</b> at the bottom of the Menu opens its{" "}
          <a href={DONATE_URL} target="_blank" rel="noreferrer">
            donation page
          </a>{" "}
          in your browser. The app sends nothing and tracks no one.
        </p>
      </>
    ),
  },
];

/** Clears `tipsSeen`, so the tips show on the next story opened. */
function ShowTipsAgain() {
  const [said, setSaid] = useState("");
  return (
    <p className="row">
      <button
        type="button"
        onClick={() =>
          endTips("again").then(
            () => setSaid("The tips will show the next time you open a story."),
            (failure: Error) => setSaid(failure.message),
          )
        }
      >
        Show the tips again
      </button>
      <span role="status" className="muted">
        {said}
      </span>
    </p>
  );
}

export function Guide({ section }: { section?: string }) {
  const shown = SECTIONS.find(({ slug }) => slug === section) ?? SECTIONS[0]!;
  return (
    <Sheet
      view={shown.slug}
      tabs={<MenuRibbon />}
      rail={
        <>
          <h1 className="big">Reader's Guide</h1>
          <nav aria-label="Guide sections">
            {SECTIONS.map(({ slug, name }) => (
              <a key={slug} href={`#/guide/${slug}`} aria-current={slug === shown.slug ? "page" : undefined}>
                {name}
              </a>
            ))}
          </nav>
        </>
      }
    >
      <article className="guide">
        <h2>{shown.name}</h2>
        {shown.body}
      </article>
    </Sheet>
  );
}
