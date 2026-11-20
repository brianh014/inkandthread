# The bench loop

How to have Claude improve the Narrator on its own: run the bench, have a blind judge score it, fix what it finds, and run again, alternating models, until the score plateaus and no bugs are left. It can run unattended, such as overnight. `CLAUDE.md` → Running the bench covers a single run; this is the loop built on it.

Start a session with: "Run the bench loop in `bench/LOOP.md`", adding any changes to the defaults below (a world, models, a stopping rule).

## Before you start

- A clean branch other than `main`, with the work so far committed.
- `bench/settings.json` set up (git-ignored, holds keys; never print it). Local ComfyUI running if pictures are drawn.
- An OpenRouter key limit you're happy to hit: it is the loop's money stop.
- The rubric (`RUBRIC`, `GENRES` and `JUDGE_RULES` in `bench/bench.ts`) settled first. It stays fixed for the whole loop, or scores stop comparing.

## Defaults

| | |
|---|---|
| World | `bench/worlds/mystery.json`, 45 rounds, 1 run per round |
| Pairings, alternating | GLM narrates and DeepSeek reviews: `--narrator z-ai/glm-5.3-flash --reviewer deepseek/deepseek-v4.1-flash-1017`. Then DeepSeek narrates and GLM reviews: the two swapped. Pass models by flag only. |
| Judge | A blind Fable 5.2 subagent at high effort. Self-judging ran about a point generous. |
| Fixer | An Opus subagent, test-first |
| Pictures | `--draw` on local ComfyUI; without it if ComfyUI is down, noted in the ledger |
| Stop | Each pairing's last two runs are within 0.3 of its own best overall, and the judge finds no app bug. Then one 45-round check each on the other genre worlds (adventure, romance, horror), fixing only app bugs they show. |

The first run of each pairing is its baseline: runs with other models, or before a rubric change, don't compare.

## Rules for changes

- **Scope per round:** at most the judge's top three findings plus clear bugs, and at most one radical change, so a drop can be traced and undone.
- **Allowed:** any change to code, prompts, retries, thinking levels or which call does what, within `CLAUDE.md`'s product rules.
- **Not allowed:** stats or visible Checks, a setting the player must touch, changing the models in `bench/settings.json`, editing bench worlds, or changing the rubric. A rubric problem goes in the ledger for a human.
- **Prompts stay general** (`CLAUDE.md` → Model prompts). A rule written for one kind of story is kept only if it helps across genres. It must hold on a second world (one 45-round run scoring no lower there than its last), and is marked "specific" in the ledger.
- **Noise:** one play moves about a quarter point.
  - Bug fixes stay whatever the score does.
  - A radical change is reverted (`git revert`) if the next run on the same pairing drops more than 0.5.
- **Commits:** one commit per fix round on the loop's branch, bumping `BENCH_ITERATION`. Never on `main`, never a `v` tag. Pushing is the human's call; say so when starting.

## Each round

The main session only coordinates and keeps the ledger, so its context stays small. The run, the judging and the fixing each happen outside it.

1. **Run** in the background:
   `bun bench run --world <world> --rounds 45 --runs 1 --judge self --label <pairing>-<iteration> --draw --keep-save --yes <pairing flags>`
   On the notification, read only its summary lines: `grep -vE "play 1 round|judge\.|^\s*$"` on the output.
2. **Judge** with a general-purpose subagent, model Fable, high effort, given the brief below.
3. **Decide** which findings to fix, after a targeted grep of the log or code confirms each bug. Don't read the transcript in full.
4. **Fix** with an Opus general-purpose subagent, given the chosen findings with their evidence and the fixer brief below.
5. **Record** one row in the ledger, then start the next run with the other pairing.

### Judge brief

> You are blind-judging one bench play of Ink & Thread. Don't read `result.json`, other runs or `bench/results/`, change no repo file, and call no model.
>
> 1. Read `<run folder>/judge.md` (the rubric and schema), the world file, and the whole `play-1/transcript.md`.
> 2. Look at the pictures in `play-1/pictures`.
> 3. Grep `play-1/inkandthread.log` (never read it whole) for "Turn committed", "State Upkeep", "World moved on", "dropped", "Choices", "Unusable Narrator reply" and "failed". Check what State Upkeep recorded and what slipped through.
> 4. Score strictly by the rubric.
> 5. Write the JSON array to `<run folder>/fable-scores.json` and run `bun bench judge <run folder> --by claude-fable-5-2 --scores <that file>`.
> 6. Write your full report to `<run folder>/fable.md`.
>
> Last round changed: `<list>`. Say whether each held.
>
> Return at most 300 words:
> - the overall and genre scores;
> - which changes held;
> - your top three findings with evidence (Message or round numbers), each with the likely cause in the code and a general fix;
> - any app bugs.

### Fixer brief

> Fix these findings: `<findings with evidence>`.
>
> - Follow `CLAUDE.md` and `CONTRIBUTING.md`.
> - Write a test that fails without each fix.
> - Keep prompt wording general.
> - Add a log line with counts only for each new outcome.
> - Bump `BENCH_ITERATION`.
> - Run `bun run format`, then `bun run check` until it passes.
> - Run `bun bench run --fake --world <world> --rounds 6 --runs 1 --yes` and compare its warnings with the last fake run.
> - Edit files with the Edit or Write tools, not Python or a shell heredoc: Python on Windows writes CRLF, and the shell eats backslashes.
> - Add a dated section to the bench ticket.
> - Commit.
>
> Return at most 150 words: what changed, the tests and the commit hash.

## Failures

- **Credit or limit error** (HTTP 402, or OpenRouter saying the key's limit is reached): stop and write the summary.
- **Any other failure of a whole run** (5xx errors, timeouts, no Turns):
  1. Wait 20 minutes, with a scheduled wake-up rather than a foreground sleep, and retry the same run.
  2. Repeat up to 6 times.
  3. If it still fails, switch that run to the other pairing, note it, and go on.
- **An action the session's permission mode refuses:** skip it, record it as blocked, and never retry it in a loop. A hook that rewrites subagent calls, such as context-mode's, makes auto mode refuse the first launch. Issue it again with exactly the input the refusal quotes.

## The ledger

`.scratch/bench-loop.md` holds the loop's record.

**Summary at the top**, rewritten at the end:
- start and end scores per pairing;
- the changes kept;
- anything reverted or marked specific;
- blocked actions;
- rubric issues for a human.

**Then a table**, one row per run:

| # | version | pairing | judge overall | genre | cost | retries / failed rounds | what this round fixed | notes |
|---|---|---|---|---|---|---|---|---|

The judge's full reports stay in each run's folder as `fable.md`.

Keeping a result (`bun bench keep`, `bun bench chart`) and opening a PR are left to a human after the loop.
