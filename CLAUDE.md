## What Ink & Thread is

A choose-your-own visual novel written as you play: set it up once, then play a story like a Telltale game or a choose-your-own-adventure book. The Narrator plots in secret (Plot Threads, the world moving on), so the story surprises the player, and scene pictures make it a visual novel. The Plot Threads are hidden, not fixed: they answer the player's choices rather than steering them back to a set path. Like a long series of books, with the same main character in the same world, the story never ends as a whole. Each Plot Thread should build to a natural ending, and the new ones that take the place of those resolved should continue naturally from what came before (ticket 79 checks this in play; today the World Moves On step, at natural pauses, rewrites threads by what their people did out of sight, removes one with nothing left to play out, and adds new ones whenever fewer than three are open). It is a story, not an AI game master: Checks stay hidden, with no stats or rules systems, and the dice are there to counter AI agreeableness, not as an RPG mechanic. The PC never dies for good, but other characters can die when the story calls for it or when the PC's choices lead there, and the Narrator should not shy away from that. It is free, standalone or self-hosted, and the player brings their own models, so they own their content: stories are files on their own computer, with no platform, account or company content rules. For privacy they can run a local model, or pin an OpenRouter Provider whose policy is not to store or log prompts.

Judge a change by whether it serves surprise from hidden Plot Threads, choices that matter, the pictures, or setting up and playing with no tuning. Features are on by default and work without the player seeing them. Leave power-user tooling (a model for every task, node editors, chatting with a director, playing as other characters, many toggles) to rivals such as Talemate. An optional setting is fine where it changes the results, such as a second model for reviews, as long as play works well without touching it. `.scratch/research/reports/NovelForge versus AI roleplay apps.md` has the comparison.

## Agent skills

### Issue tracker

Issues and specs live as local markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the five default triage labels, recorded on a `Status:` line in each issue file. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Project rules

Create an HTML report of UI options only when the user asks for one, for a large visual change. Otherwise build UI changes directly.

Follow the conventions in `CONTRIBUTING.md`: Glossary terms, `shortcut:` comments, Zod at every route, allowlisted responses, and no key or story text in a log, except through Story in log (`log.story`), which the player turns on to debug.

Log every action by default, whether the player, the app or the AI takes it: what happened, with ids, counts, settings values and outcomes, such as a Check's difficulty and result or the names of a Turn's state operations. Keys and story text stay out unless Story in log is on. The shared route wrapper (`logged` in `src/http.ts`) already logs every request that changes something at Info, the downloaded app's default level, with its route, Save, method and status. So a change that adds an action, such as a route, a tool, a Narrator operation or a background job, adds a detail line where the outcome needs more than a status, as "Turn committed" and "World Change applied" do. Do it in the same change, so nothing goes unrecorded.

### Recommended setup

`README.md` → Recommended settings is the player-facing version. When advising on providers or changing defaults and Settings hints, keep to it:

- Text: a hosted API is recommended: OpenRouter or NanoGPT as equal choices, never one preferred over the other (OpenRouter pins a provider; NanoGPT's subscription is a flat price), or Google AI Studio's free key to try it. A long story's prompt runs past 30,000 tokens, which a 10 GB GPU can't hold. Local text (Local / OpenAI server) is supported for short stories, privacy and trying things out, not the main path.
- Images: local ComfyUI is preferred, as Ink & Thread draws many pictures and each costs money on a paid API. OpenRouter, NanoGPT or Wiro is for players with no GPU for ComfyUI.

### Code layout

- The server's routes are split by area, one module each: `settings-routes`, `world-routes`, `save-routes`, `turn-routes` and `gallery-routes` (ADR 0004). A new route goes in its area's module. State only one area uses stays private to that module. `src/http.ts` holds what they share, and `rest-api.ts` only puts them together.
- `Play` (`src/web/play.tsx`) keeps the Turn and the state its parts share. The parts are in their own files: `story-pictures.tsx` (the `useStoryPictures` hook and the pictures inline in the story), `story-recap.tsx` (the left page), `message-controls.tsx` (the tools under a Message) and `play-asks.tsx` (the forms over the compose box). A new piece of the story screen goes in the file for its job.
- `NewStory` (`src/web/wizard.tsx`) keeps the form's state, the Narrator calls and the Art and Your World steps. The parts are in their own files: `wizard-draft.ts` (the draft, its themes and keeping it in the tab), `wizard-form.tsx` (the first step's boxes), `wizard-pictures.tsx` (a picture with its Draw, Redo, Nudge and Upload) and `wizard-frame.tsx` (the heading, the Working screen and the dialogs). A new piece of the New Story screen goes in the file for its job.

### Model prompts

The prompts in `src/prompt-assembler.ts` and `src/world-creation.ts` go into every call, so they must stay lean. When play shows a problem, find the wider principle it breaks, such as people staying true to what they said rather than one character leaving early, and fix that once, in general words. Prefer widening or rewording a rule that's already there over adding one. Never add a rule for one story's case, or examples drawn from the story being debugged, as a pile of specific tweaks bloats every prompt and boxes in the model's invention. If a problem can be fixed in code instead, prefer that, preventing it before the reply is written over checking it after.

### Replies the player reads

- Everything the player types is the PC's own words and actions, a bare quote included. The player never speaks or acts for anyone else, so a fix for a misread move makes the move unmistakably the PC's, such as the PC's name sent with it.
- A retry is a last resort, as the player waits through it or sees the text restart. Prevent the fault first: how the prompt or move is built, a schema, or the state sent. Never add a retry in the player's path to enforce a rule; one off it (State Upkeep, World Moves On) still costs time and money.
- Code never cuts, rewrites or stops early a reply's story text, as the rest of the reply was written around it and a reply stopped early can be a sentence long, and never changes text the player has read. It may fix only format, such as stray JSON or a field name. When a reply's text itself is broken, such as one that restarts the story, writing it again beats keeping it with its state repaired.

### Reader's Guide

`src/web/guide.tsx` is the player's help, on the Menu. When a change adds, removes or renames something a player sees (a tool, a setting, a screen), update its section in the Guide too, with the tool's icon beside its name as the other tools have. It says "AI", not "text model" or "image model".

### CI and releases

- The repo, Issues and releases are on GitHub (`origin`, https://github.com/brianh014/inkandthread). The `gitea` remote is only the user's private backup; push there only when asked. `.github/workflows/ci.yml` runs `bun run check` and `bun run e2e` on pushes and pull requests.
- Releases are published by GitHub: `bun run publish-release`, run by the user from an up-to-date `main`, tags the commit `v<version>` from `package.json` and pushes the tag. `.github/workflows/release.yml` then builds the downloads on a Windows runner (Bun sets the Windows icon only when building on Windows) and publishes the GitHub release. Run by hand from the Actions tab, it only builds, as a trial. A version with a hyphen (`-alpha.2`) is a pre-release, which the New Version toast and Settings → Updates (`src/web/new-version.tsx`, `src/updater.ts`) never offer: it offers only GitHub's latest full release, and swaps the program file for the one in that release's download. Keep the download names in `scripts/build-release.ts` and `downloadName` in step. The user decides when to release; never push a `v` tag yourself.
- Pull requests are squash-merged, the only merge GitHub allows on this repo (repo settings and the "Protect main" ruleset), and the squash commit takes the PR's title and description. So before merging, make the title and description an accurate summary of the whole branch as it now stands, following `.github/pull_request_template.md`, and update them if the branch changed after the PR opened. Merge with `gh pr merge --squash`.
- A branch that changes the app bumps the version in `package.json` if that version is already released, that is, a `v<version>` tag exists (`git tag -l v<version>`). Bump the patch for fixes and changes to behaviour, the minor for new features, and bump once per release, not per branch: a version not yet tagged stays as it is.

### Testing the app

- To try the app in a browser, start `inkandthread-dev` from `.claude/launch.json` (port 4610). It runs with `--fake`: a stand-in Narrator and image model (`src/fake-services.ts`), no key or network, and its own Saves, Settings and logs under `fake/`.
- Agents always test with `--fake`. Never send a request to a real text model, image model or ComfyUI: they cost real money, so only a human tests real connections, with `inkandthread-dev-real` (port 4620). When a change needs that, finish it with fakes and tell the user what to try for real. The bench (Running the bench below) is the one exception.
- Never test against port 4600, which is the user's own server.
- Automated tests use the fakes in `test/` and never a real key.
- `bun run check` runs what CI runs: Biome lint and format check, the typecheck and the unit tests. `bun run format` fixes formatting. A lint suppression needs a reason (see `CONTRIBUTING.md`).
- `bun test` runs the unit tests in `test/` (about 40s). The 14s idle-timeout test runs only with `SLOW_TESTS=1`. Under `bun test`, Saves skip SQLite's flush to disk and ComfyUI polls fast; a Save that many tests seed the same way goes through `cachedSave` in `test/support.ts`.
- `bun run e2e` runs the Playwright specs in `e2e/` against `--fake` on port 4630, in a fresh `e2e/.data` folder each run (`e2e/serve.ts`). Find UI by role and label first; add a `data-testid` only where those can't tell things apart (story messages are `message-player` and `message-narrator`).
- `bun run perf` times a 1,200-Message story (opening it, typing, a Turn coming in) against `--fake` on port 4640 on React's production build, as players get, and prints the numbers. It is not in CI, as timings vary by machine; run it by hand after changes to the story screen.
- The fake Narrator builds each reply from the schema it is sent, with three of every list. Each Turn meets new people, and first any Important Character of the last world built that the PC hasn't met. It never asks for a Check, so Checks can't be clicked through. A rule the schema doesn't carry (a word limit, say) can still fail, and then the app retries and falls back as it would with a real model; teach `src/fake-services.ts` the rule if that blocks a screen.
- `bun bench` is the Narrator bench (ticket 86, usage at the top of `bench/bench.ts`): see Running the bench below.

### Running the bench

`bun bench` plays the adventure, `bench/worlds/adventure.json` (or another world with `--world <file>`, recorded in each result) on the player's real models through the real server, with every picture prompt written by the real AI but drawn by a stand-in, or with `--draw` on the player's local ComfyUI, and records what each Narrator feature did, timing, cost and a judge's scores, the pictures' prompts among them. It is how a change to the Narrator, its prompts or ticket 76's checks is judged better or worse. It costs money; running it as built needs no per-run yes, but:

1. **Ask the player for `--rounds` and `--runs`** every time, and never pick them yourself. Seeded Choices are the default; for a run steered a chosen way, the player gives typed moves in a file (`--moves`, one per line), whose count is the rounds. A Scene Memory comes only once the story outgrows the Settings' recent Messages (80 by default), about 40 rounds, so a 45-round run, the usual length, makes one and plays a few Turns from it. `--fake` tries the bench itself free.
2. **Run it** in the background (about a minute a round on MiMo; the plays of a run go at once on a hosted model): `bun bench run --rounds N --runs M --judge self --label <what changed> --yes`, adding `--draw` when the bench's Settings have local ComfyUI set up as their image provider, so the pictures themselves can be judged; it costs no money per picture, and `--draw` never draws on a paid image API. The bench plays on git-ignored `bench/settings.json`, the player's own copy kept apart so their Settings never change a run, and changes only a temporary copy of it; never print it, as it holds keys. Each play's Saves are kept in its folder, to play on or replay from later (`--from`, `--at`); delete a run's folder once nothing needs it.
   - **To test a fix for a fault seen at one Message**, replay that Turn rather than playing a fresh story, which may never reach it again: `--from <run>/play-1/Saves --at <M> --rounds 1 --runs 5`, once on the old code and once on the fix. Replay from before the cause when it lay earlier, such as a plan World Moves On wrote Turns before, as a replay keeps the state the old code built. Then one usual run checks the fix broke nothing elsewhere.
3. **Judge it yourself** (`--judge self`; `--judge narrator` only if the player asks). For each play in the run's folder:
   - Read `transcript.md`: the world rules and lore it began with, the story with each scene's picture prompt and every hidden Check, the portrait prompts, the hidden timeline (each round's Choices offered and every change to the state: Plot Threads, Loose Ends, what NPCs learned, lore and its words, world rules, known facts and people, looks, what the PC wears and carries, status, story time, place, Scene Memories with the Messages they cover, and Chapters), and at the end the summary the Narrator reads and what is still open.
   - With `--draw`, look at the pictures in the play's `pictures` folder, which the transcript names beside each prompt, and judge the pictures, not only their prompts.
   - Read `inkandthread.log`, written at Verbose with the player's Story in log: each "Turn committed" line (the Narrator's operations, the Check, State Upkeep's operations), "State Upkeep", "Choice picked", and with Story in log the prompts and replies. Check what State Upkeep recorded and what slipped through, against the run's world in `bench/worlds/`.
   - Judge it as a reader grading the story would, by the rules in `judge.md`: first walk the story in order and list every mistake a reader would notice (kind, major or minor, where), then audit each feature of the state, then score each item by its anchors with a one-line reason. Then save a JSON array of one reply per play and run `bun bench judge <run folder> --by <your model id> --scores <file>`.
4. **Report** the mistake tally first (majors and minors per 10 Turns, by kind) and the state faults code found, as the tally moves with quality where the scores bunch; then the headline numbers and how they compare with the kept result (scores only against one judged by the same rubric), the cost against the estimate, the features that never fired, the scores and their reasons, and what State Upkeep got right and wrong. Fix findings in general words (Model prompts above), never with this world's details.
5. **Keep** a run only when the player says so: `bun bench keep <run folder>`, then commit its `bench/results/` file. A run of one play may be kept, but one play's score moves about a quarter point by chance, so say so when comparing it. Runs themselves stay in git-ignored `bench/runs/`. `bun bench chart` charts the kept runs, score against cost per Turn, with a pick of bench version, score (overall or one rubric item) and story, and writes `src/web/bench-results.json`, the copy the Reader's Guide shows players under Choosing your AI (shared worlds only, never `bench/worlds-local/`); run it after keeping and commit that file too. The bench version (`BENCH_VERSION` in `bench/bench.ts`) is the app's version and an iteration, such as `0.5.0.10`: bump `BENCH_ITERATION` in any change to the prompts, the rubric, a bench world or how a Turn is checked and retried, and start it again at 1 when the app's version changes.
- Fake pictures are plain plates in the book's colours, for checking layout, not art.
- The user's real play logs to `logs/inkandthread.log` (and `.1`) in the repo root. When the player has Story in log on, it holds the prompts and replies with their story text, and reading it to diagnose a problem needs no asking, whatever the story. Never quote adult text from it back.
- `--watch` restarts the server on every code change, and an unfinished world in the New Story wizard lives only in server memory, so it is lost then: generate it again.
- `bench/LOOP.md` is the bench loop: run, a blind judge, fix, run again, alternating models, until the score plateaus, unattended if the player asks for it.
- `bench/LIVE.md` is live plays: an agent plays stories Turn by Turn (`bun bench live` and `bun bench do`) and another audits them, for how good they are to play and what breaks, with no scores. Use it to find issues and try different kinds of stories; the bench judges whether a change is better.

#### Making a bench world

A bench world is a JSON file shaped like `bench/worlds/adventure.json`, played with `--world <file>`. Runs compare only on one world, which each result records.

- `save` holds what the New Story wizard builds: `title`, `theme`, `artStyle` (a wizard style written as `Name: description`, as `src/web/art-styles.ts` has it), `worldBrief`, `startingHook`, `pc` (`name` and its text fields) and `importantCharacters` (`name`, `description`, `onCover`).
- `opening` is the state play starts from: `storyTime`, `inventory`, `status`, `worldRules`, three `plotThreads`, each saying who is behind it and what it hides, and `worldBible`, Lore Entries with keywords, `alwaysOn` only for the setting itself. Give each Important Character a keyword Lore Entry with their looks, and name them in the Starting Hook, so the opening meets them as written.
- `actions` holds the fixed words of the Rewrite, Edit and World Change the bench sends.
- The player's Model and Image Instructions never reach a run, so results compare across machines; a world that needs its own gives `modelInstructions` or `imageInstructions`, and `judge` for extra judging rules. A world written for a genre names it in `genres` (romance, mystery, horror, violence or spiciness), and every play of it must then be scored for that genre: `bun bench judge` refuses scores without it.
- Build it to bring about everything the Narrator does, as `about` in `bench/worlds/adventure.json` lists: risky Choices for Checks, a Plot Thread that can resolve within a few days of story time, secrets for NPCs to learn, Loose Ends, lore to grow, mortal danger and people who may die.
- `bench/worlds/` holds worlds in other genres (mystery, romance, horror), to check a prompt change doesn't help one kind of story and hurt another. The romance sets up desire between two adults so it can turn sexual, but never starts there: how far it goes is left to play.
- Invent it, never from a player's Save. A world kept out of git, such as an adult one (ticket 89), goes in git-ignored `bench/worlds-local/` with its `--moves` file.
- Try it free first with `bun bench run --fake --world <file> --rounds 2 --runs 1 --yes`, and read the transcript.
