# Contributing to Ink & Thread

Thanks for helping. This page covers setting up, the checks a change must pass, and the conventions the code follows.

## Setting up

1. Install [Bun](https://bun.sh) 1.4 or later.
2. `bun install`
3. `bun src/main.ts --fake --open` runs the app with a stand-in Narrator and image model, so you need no key and spend no money.

Develop with `--fake`. Its stand-ins (`src/fake-services.ts`) build each reply from the schema they are sent, and keep their own Saves and Settings under `fake/`, apart from your real ones. Test against a real model only by hand, and only when a change needs it.

## Checks

Every pull request runs these in CI, and they should pass locally first:

| Command | What it checks |
| --- | --- |
| `bun run check` | Biome lint and formatting, the TypeScript typecheck, and the unit tests in `test/` |
| `bun run e2e` | The Playwright specs in `e2e/`, against `--fake` on port 4630 |
| `bun run format` | Formats every file the way `check` expects |

A change to how the story is written (the Narrator's prompts, its checks and retries, State Upkeep, World Moves On or picture prompts), or a new text provider, also needs the Narrator bench run on a real model before it merges: `bun bench run`, with usage at the top of `bench/bench.ts`. Put the run's headline numbers and judged scores, compared with the kept result, in the pull request. The judged scores must stay the same or improve: a change that lowers them doesn't merge until it no longer does. One play's score moves about a quarter point by chance, so a drop that small counts only once more runs confirm it. Try it free first with `--fake`. A change to the prompts, the checks or a bench world also bumps `BENCH_ITERATION` in `bench/bench.ts`.

Unit tests use the fakes in `test/` and never a real key. `SLOW_TESTS=1 bun test` also runs the slow idle-timeout test. In e2e specs, find elements by role and label first, and add a `data-testid` only where those can't tell things apart.

## Conventions

- **Words:** use the terms in [`GLOSSARY.md`](GLOSSARY.md), in code, comments and the UI alike. Add a term there when you add a concept.
- **Decisions:** record a decision that shapes the design as an ADR in [`docs/adr/`](docs/adr/), numbered after the last.
- **Comments** say why, not what. A known limit taken on purpose gets a comment starting `shortcut:`, which names the limit and when to lift it.
- **Server routes** live in one module per area (`*-routes.ts`), which takes the shared `ServerContext` from `src/http.ts`. Validate every request body with a Zod schema through `parseBody`, and answer with an allowlist of fields, never a whole stored object.
- **Secrets:** an API key must never reach a response or a log line. Logs carry counts and ids, never story text, except the prompts and replies when the player turns on Story in log (Settings → Advanced) for debugging.
- **Lint suppressions** need a reason: `// biome-ignore lint/<group>/<rule>: why`. `useExhaustiveDependencies` is off, as many effects deliberately re-run on a trigger value or leave out functions made anew on each render.
- **Tests:** a bug fix comes with a test that fails without it. Test through the HTTP routes or a module's exported functions, as the app uses them.

## Sending a change

1. Keep it to one purpose, and say why in the description.
2. Run `bun run check` and `bun run e2e`, and the bench when the change touches how the story is written or adds a text provider (see Checks).
3. A visible change needs a look in the browser with `--fake`, and a screenshot in the pull request helps.
4. Pull requests are squash-merged, so the pull request's title and description become its one commit on `main`. Write them as that commit's summary of the whole change, and keep them accurate if the branch changes before it merges.

By contributing, you agree that your contribution is licensed under the project's [license](LICENSE), the GNU AGPL 3.0.
