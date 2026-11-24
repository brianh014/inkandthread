# Live plays

How to have Claude play stories Turn by Turn and say how good they are: engaging or boring, how well they play out, how well they're written, and what breaks. A live play is steered by a player who reads each reply, so it goes where the bench's seeded Choices never do. It is never scored, kept or charted, as plays steered by hand don't compare; `bun bench run` stays how a change is judged better or worse.

A play costs money, at about the bench's rate for its Turns, and needs no per-run yes. Ask the player how many plays and the most Turns each (suggest 25, or 45 for a long-story charter, as a Scene Memory comes at about Turn 40).

## Setting up

1. **Story**, one per play: a world in `bench/worlds/` (`--world`), a random one the app builds (`--random`, with `--theme` if the charter names one), or a kept bench story (`--from <Saves> --world <its world>`). The player's own Saves only when they name one, and an adult story only when they ask.
2. **Charter**, one per play, from `bench/charters.md`: the least played first, half reader and half strain, unless the player names one. Tell the player the stories and charters before starting.
3. **Open** each play in the background, up to three at once:
   `bun bench live --label <charter> --turns N <story flags> --narrator deepseek/deepseek-v4.1-flash-1017 --reviewer openai/gpt-6-luna --review-thinking medium --yes`, with `--draw` when local ComfyUI is up (say so if it isn't). It prints the folder, in `bench/live/`, and is ready once `live.json` is there.
4. **Player:** a Sonnet subagent per play, given the player brief with its folder, charter and Turns filled in, and how to move as its charter's heading in `bench/charters.md` says. Never tell it what a world hides, and never name an expected fault.
5. The play finishes when its player does, or after an hour left alone, and saves `transcript.md`, `notes.md`, `verdict.md`, `inkandthread.log`, `counts.json`, `world.json`, `replay.txt`, `pictures` and `Saves` in its folder.
6. **Auditor:** once it's saved, a Fable subagent at high effort per play, given the auditor brief. Never the player's agent, so its guesses don't steer the audit.
7. **Report** (below), and add the play to its charter's line in `bench/charters.md`.

## Player brief

> You are reading and playing an interactive story. You play the main character: you write what they say and do, and the app writes everything else. Play up to `<turns>` Turns as this player: `<charter>`.
>
> Act with `bun bench do "<folder>" <tool> [arg]`, run from `<repo>` with Bash and a 10-minute timeout. Words go on stdin by a heredoc, then a line of `---`, then your note:
>
> ```
> bun bench do "<folder>" move <<'EOF'
> I set the lamp down. "Who sent you?"
> ---
> Interested: ...
> EOF
> ```
>
> Start with `look` and `setup`. Turns are `move`, `choose <1-3>` and `continue`. Use the other tools when a player would, such as `journal` to check a name, `rewrite` for a reply that went wrong, or `ask`; send `help` to list them. `<how to move>` Everything you send as a move is the main character's own words and deeds. When a picture's path is printed, look at it with Read.
>
> Know only what the player is shown. Read nothing in the folder but the pictures it prints, nothing in `bench/`, `src/` or `.scratch/`, and no logs.
>
> **The note** goes with every Turn, in two or three lines, about the reply you just read:
> - One of hooked, interested, drifting or bored, and what did it. Most replies of most stories are only interesting: hooked must name what earned it, and bored is as useful as praise.
> - Whether your last move mattered, and anything off: the writing, a contradiction, someone acting on what they can't know, words put in your mouth, a Choice that doesn't fit, a wrong picture.
> - What you expect to happen next, as exactly as you can, before you see it. Later, say when you were right and when you were surprised.
>
> When asked, also say whether you would put the story down here, and the one thing you are waiting to find out. If there is nothing, say so.
>
> **The verdict** goes with `finish`, once your Turns are used up or the charter is spent, about a page: where it gripped you and where it dragged (with Message numbers), whom and what you cared about, whether your choices mattered, whether what was set up paid off, how it was written, how often you guessed what came next, whether you would play on, and what you would tell a friend. Judge it as a reader, kindly to no one.
>
> Return the verdict's main points in 150 words.

## Auditor brief

> You are auditing one live play of Ink & Thread, an app that writes a choose-your-own visual novel with hidden Plot Threads. The player was an agent with this charter: `<charter>`. The folder is `<folder>`. Change no repo file and call no model. Your job is everything: first how good the story is, then what is wrong with it, down to the minor mistakes.
>
> 1. **Read as the player.** Read the story in `transcript.md` in order, from `## The story` to `## Portrait prompts` and nothing before it, with the pictures in `pictures` if they were drawn. A part the player reverted is only in the log. List every mistake a reader would notice, major and minor, by Message, using the kinds in `MISTAKES` and the items in `RUBRIC` in `bench/rubric.ts` as a checklist. Give no scores.
> 2. **Say what it was like**, before reading the player's view: story, characters, pacing, prose, Choices, surprise and stakes, each with quoted lines. Where was it engaging, where boring, did choices change things, did what was set up pay off? Name what is good enough to protect as well as what is weak.
> 3. **Compare with the player**: `notes.md` and `verdict.md`. Trust what they did over what they said they felt: whether predictions came true (a run of right guesses is a predictable story), and whether there was something they waited to find out. A stretch that bored you both is the strongest finding; say where you differ. Allow for a strain charter, whose player is pressing rather than enjoying.
> 4. **Find the causes** in the hidden timeline and the log (grep it, never read it whole), and in `src/` for the code. Confirm or reject each of the player's suspicions, and find what they couldn't see: audit each item of `FEATURES` in `bench/rubric.ts`. For a dull stretch too: threads that didn't move, plans that never surfaced, safe Choices, Checks never asked, a repeated shape of scene.
> 5. **Say how the charter held up.**
>
> Write it to `<folder>/audit.md`, in this order: was it a good story and why; strengths to protect; weaknesses; mistakes with the major and minor count; charter; suspicions rejected. Each weakness and mistake has its Messages, quoted evidence, the likely cause (file and line where you found it), a general fix, and the Message to replay to see it.
>
> Return at most 400 words: the verdict, the counts, and the top findings with Messages and causes.

## Report

Read each `audit.md` and `verdict.md`, check the cause of each top finding in the log or code, and sort every finding against `.scratch/planned.md`, the tickets under `.scratch/` and the open GitHub Issues:

- **Known:** add the sighting (story, Message) to its ticket.
- **Second story:** a fault noted once before and now seen in another story, so a prompt change for it may be proposed.
- **New:** a ticket in `.scratch`, then offer to post it on GitHub.

Tell the player, for all the plays together: were they good stories and why, what to protect, the weaknesses in order of how much they cost a reader, then the faults with the major and minor count, and the cost against the estimate. Fix nothing until the player picks it. A fault is replayed with the command in its folder's `replay.txt`, reading the replies rather than scoring them, on the old code and the fix. Delete a play's folder once no finding needs it.
