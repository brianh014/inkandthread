## What NovelForge is

A choose-your-own visual novel written as you play: set it up once, then play a story like a Telltale game or a choose-your-own-adventure book. The Narrator plots in secret (Plot Threads, the world moving on), so the story surprises the player, and scene pictures make it a visual novel. The Plot Threads are hidden, not fixed: they answer the player's choices rather than steering them back to a set path. Like a long series of books, with the same main character in the same world, the story never ends as a whole. Each Plot Thread should build to a natural ending, and the new ones that take the place of those resolved should continue naturally from what came before (ticket 79 checks this in play; today State Upkeep moves on or resolves a thread play has overtaken, and the Turn prompt adds new ones whenever fewer than three are open). It is a story, not an AI game master: Checks stay hidden, with no stats or rules systems, and the dice are there to counter AI agreeableness, not as an RPG mechanic. The PC never dies for good, but other characters can die when the story calls for it or when the PC's choices lead there, and the Narrator should not shy away from that. It is free, standalone or self-hosted, and the player brings their own models, so they own their content: stories are files on their own computer, with no platform, account or company content rules. For privacy they can run a local model, or pin an OpenRouter Provider whose policy is not to store or log prompts.

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

- Text: a hosted API is recommended (OpenRouter, or Google AI Studio's free key to try it). A long story's prompt runs past 30,000 tokens, which a 10 GB GPU can't hold. Local text (Local / OpenAI server) is supported for short stories, privacy and trying things out, not the main path.
- Images: local ComfyUI is preferred, as NovelForge draws many pictures and each costs money on a paid API. OpenRouter, NanoGPT or Wiro is for players with no GPU for ComfyUI.

### Code layout

- The server's routes are split by area, one module each: `settings-routes`, `world-routes`, `save-routes`, `turn-routes` and `gallery-routes` (ADR 0004). A new route goes in its area's module. State only one area uses stays private to that module. `src/http.ts` holds what they share, and `rest-api.ts` only puts them together.
- `Play` (`src/web/play.tsx`) keeps the Turn and the state its parts share. The parts are in their own files: `story-pictures.tsx` (the `useStoryPictures` hook and the pictures inline in the story), `story-recap.tsx` (the left page), `message-controls.tsx` (the tools under a Message) and `play-asks.tsx` (the forms over the compose box). A new piece of the story screen goes in the file for its job.
- `NewStory` (`src/web/wizard.tsx`) keeps the form's state, the Narrator calls and the Art and Your World steps. The parts are in their own files: `wizard-draft.ts` (the draft, its themes and keeping it in the tab), `wizard-form.tsx` (the first step's boxes), `wizard-pictures.tsx` (a picture with its Draw, Redo, Nudge and Upload) and `wizard-frame.tsx` (the heading, the Working screen and the dialogs). A new piece of the New Story screen goes in the file for its job.

### Model prompts

The prompts in `src/prompt-assembler.ts` and `src/world-creation.ts` go into every call, so they must stay lean. When play shows a problem, find the wider principle it breaks, such as people staying true to what they said rather than one character leaving early, and fix that once, in general words. Prefer widening or rewording a rule that's already there over adding one. Never add a rule for one story's case, or examples drawn from the story being debugged, as a pile of specific tweaks bloats every prompt and boxes in the model's invention. If a problem can be fixed in code instead, such as a check on the reply, prefer that.

### Reader's Guide

`src/web/guide.tsx` is the player's help, on the Menu. When a change adds, removes or renames something a player sees (a tool, a setting, a screen), update its section in the Guide too, with the tool's icon beside its name as the other tools have. It says "AI", not "text model" or "image model".

### CI and releases

- The repo, Issues and releases are on GitHub (`origin`, https://github.com/brianh014/novelforge). The `gitea` remote is only the user's private backup; push there only when asked. `.github/workflows/ci.yml` runs `bun run check` and `bun run e2e` on pushes and pull requests.
- Releases are published by GitHub: `bun run publish-release`, run by the user from an up-to-date `main`, tags the commit `v<version>` from `package.json` and pushes the tag. `.github/workflows/release.yml` then builds the downloads on a Windows runner (Bun sets the Windows icon only when building on Windows) and publishes the GitHub release. Run by hand from the Actions tab, it only builds, as a trial. A version with a hyphen (`-alpha.2`) is a pre-release, which the New Version toast and Settings → Updates (`src/web/new-version.tsx`, `src/updater.ts`) never offer: it offers only GitHub's latest full release, and swaps the program file for the one in that release's download. Keep the download names in `scripts/build-release.ts` and `downloadName` in step. The user decides when to release; never push a `v` tag yourself.
- Pull requests are squash-merged, the only merge GitHub allows on this repo (repo settings and the "Protect main" ruleset), and the squash commit takes the PR's title and description. So before merging, make the title and description an accurate summary of the whole branch as it now stands, following `.github/pull_request_template.md`, and update them if the branch changed after the PR opened. Merge with `gh pr merge --squash`.
- A branch that changes the app bumps the version in `package.json` if that version is already released, that is, a `v<version>` tag exists (`git tag -l v<version>`). Bump the patch for fixes and changes to behaviour, the minor for new features, and bump once per release, not per branch: a version not yet tagged stays as it is.

### Testing the app

- To try the app in a browser, start `novelforge-dev` from `.claude/launch.json` (port 4610). It runs with `--fake`: a stand-in Narrator and image model (`src/fake-services.ts`), no key or network, and its own Saves, Settings and logs under `fake/`.
- Agents always test with `--fake`. Never send a request to a real text model, image model or ComfyUI: they cost real money, so only a human tests real connections, with `novelforge-dev-real` (port 4620). When a change needs that, finish it with fakes and tell the user what to try for real.
- Never test against port 4600, which is the user's own server.
- Automated tests use the fakes in `test/` and never a real key.
- `bun run check` runs what CI runs: Biome lint and format check, the typecheck and the unit tests. `bun run format` fixes formatting. A lint suppression needs a reason (see `CONTRIBUTING.md`).
- `bun test` runs the unit tests in `test/` (about 40s). The 14s idle-timeout test runs only with `SLOW_TESTS=1`. Under `bun test`, Saves skip SQLite's flush to disk and ComfyUI polls fast; a Save that many tests seed the same way goes through `cachedSave` in `test/support.ts`.
- `bun run e2e` runs the Playwright specs in `e2e/` against `--fake` on port 4630, in a fresh `e2e/.data` folder each run (`e2e/serve.ts`). Find UI by role and label first; add a `data-testid` only where those can't tell things apart (story messages are `message-player` and `message-narrator`).
- `bun run perf` times a 1,200-Message story (opening it, typing, a Turn coming in) against `--fake` on port 4640 on React's production build, as players get, and prints the numbers. It is not in CI, as timings vary by machine; run it by hand after changes to the story screen.
- The fake Narrator builds each reply from the schema it is sent, with three of every list. Each Turn meets new people, and first any Important Character of the last world built that the PC hasn't met. It never asks for a Check, so Checks can't be clicked through. A rule the schema doesn't carry (a word limit, say) can still fail, and then the app retries and falls back as it would with a real model; teach `src/fake-services.ts` the rule if that blocks a screen.
- `bun bench` is the Narrator bench (ticket 86, usage at the top of `bench/bench.ts`): see Running the bench below.

### Running the bench

`bun bench` plays `bench/world.json` on the player's real models through the real server, with every picture prompt written by the real AI but drawn by a stand-in, and records what each Narrator feature did, timing, cost and a judge's scores, the pictures' prompts among them. It is how a change to the Narrator, its prompts or ticket 76's checks is judged better or worse. It costs money; running it as built needs no per-run yes, but:

1. **Ask the player for `--rounds` and `--runs`** every time, and never pick them yourself. Seeded Choices are the default; for a run steered a chosen way, the player gives Free Text moves in a file (`--moves`, one per line), whose count is the rounds. About 20 rounds are needed for a Scene Memory or Chapter to come up. `--fake` tries the bench itself free.
2. **Run it** on a scratchpad copy of `settings.json`, in the background (about a minute a round on MiMo; the plays of a run go at once on a hosted model): `bun bench run --rounds N --runs M --judge self --label <what changed> --settings <copy> --yes`. When it ends, delete the copy with `rm -f` on its absolute path, as a command of its own.
3. **Judge it yourself** (`--judge self`; `--judge narrator` only if the player asks). For each play in the run's folder:
   - Read `transcript.md`: the story with each scene's picture prompt, every hidden Check, the portrait prompts, and the hidden timeline (the Choices offered each round, Plot Threads, Loose Ends, what NPCs learned, lore added).
   - Read `novelforge.log`, written at Verbose with the player's Story in log: each "Turn committed" line (the Narrator's operations, the Check, the consistency scores and outcome, State Upkeep's operations), "State Upkeep", "Choice picked", each "Decision"'s scores, and with Story in log the prompts and replies, including the reviewer's fix edits (`narration_edits`) and each "Decision request text". Check each fix was right, each "not a slip" was, and what slipped through unflagged, against the world in `bench/world.json`.
   - Score it by the rubric in `judge.md`, with a one-line reason each, then save a JSON array of one reply per play and run `bun bench judge <run folder> --by <your model id> --scores <file>`.
4. **Report** the headline numbers and how they compare with the kept result, the cost against the estimate, the features that never fired, the scores and their reasons, and what the consistency checks and State Upkeep got right and wrong. Fix findings in general words (Model prompts above), never with this world's details.
5. **Keep** a run only when the player says it's a best result: `bun bench keep <run folder>`, then commit its `bench/results/` file. Runs themselves stay in git-ignored `bench/runs/`.
- Fake pictures are plain plates in the book's colours, for checking layout, not art.
- The user's real play logs to `logs/novelforge.log` (and `.1`) in the repo root. When the player has Story in log on, it holds the prompts and replies with their story text, and reading it to diagnose a problem needs no asking, whatever the story. Never quote adult text from it back.
- `--watch` restarts the server on every code change, and an unfinished world in the New Story wizard lives only in server memory, so it is lost then: generate it again.
