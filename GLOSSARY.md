# Ink & Thread

A single-player, AI-driven choose-your-own visual novel. The player acts and speaks only as their character while an LLM runs the story and world.

## Language

### Roles

**Narrator**:
The LLM role that drives the story, voices NPCs, and proposes changes to the world.
_Avoid_: The LLM, the AI, GM

**PC**:
The character the player controls. The player may only say and do things as the PC.
_Avoid_: Character (alone), player (when the character is meant)

**NPC**:
Any character in the world voiced by the Narrator.

**What an NPC Knows**:
A hidden list for each NPC of what they have learned or lived through in play, newest last. Past twelve entries, the Scribe folds the oldest into one short summary at the next pause, never the NPC's own part of a Plot Thread. The Narrator sees only the lists of the NPCs in the scene or named by the player, and adds to one with `npc_learns`. The player never sees it, as it can hold what the PC never saw.

### Story structure

**Story**:
One world and PC played from the Opening on, held in a Save and always called by its Title. A Save with no Title goes by the PC's name.
_Avoid_: Game

**Message**:
A single entry in the chat history, and the unit the player can revert to.

**Turn**:
One player input together with the Narrator's response to it.
_Avoid_: Message (when the input-and-response pair is meant)

**Scene**:
A continuous place and situation in the story. A Scene can have several Scene Images over time, such as when its cast changes.

**Cover**:
The book-cover art of a story, with its title lettered into the picture, drawn from what the player can read: the Title, theme and World Brief if the player draws it while creating the story, otherwise the World Overview. It is kept in the Save through every Revert.
_Avoid_: Title image, world image

**Opening**:
The Narrator's first Message, which brings the player up to speed before they act. It is a first Turn whose stored player Message the story never shows.

**Continue**:
A Turn with no player input, in which the people and world around the PC carry the moment on by one beat, without moving time on or ending what is under way, with no Check. The story shows a short rule where its player Message would be.

**Chapter**:
A titled run of consecutive Messages, read as one piece in the Journal. One Chapter is always open, the one play is adding to. Only the player closes it, sometimes on the Narrator's suggestion, and closing starts the next. The Opening begins Chapter 1, and a Chapter never splits a Turn. Chapters don't change what the Narrator is sent.
_Avoid_: Act, part, Scene (that is a place and situation, and a Chapter may hold many)

**Scene Image**:
A generated image showing the current moment of a Scene, drawn when the Scene changes, or also when enough happens within it if the player asks for more.

**Requested Image**:
An extra picture drawn on the spot from the player's own words and the recent story, which joins the latest Message beside any Scene Image. It is not a Turn, so the Narrator never hears about it.
_Avoid_: Scene Image (that is what a Turn draws)

**Image Prompt**:
The main text an image was drawn from, which the player can read and change. Art Style and other drawing choices are not part of it.
_Avoid_: Visual description (that is only the Narrator's part of a Scene Image's prompt)

**Prompt Style**:
How an Image Prompt is worded for the kind of image model drawing it: prose or keywords. It decides the wording, never what the image shows.
_Avoid_: Model family (that is the Settings choice of which models to load)

**Redraw**:
Drawing one existing image again from its Image Prompt, replacing that image and changing nothing else in the story.
_Avoid_: Regenerate (that redoes a Turn or a whole world)

**Update**:
Drawing a Cover or portrait again from a new Image Prompt written from the story as it stands. A portrait's Update keeps the face of the portrait it replaces; a Redraw draws a new one.
_Avoid_: Redo

**Review**:
A second AI call that checks a new world, or a World Change before it is applied, for faults such as contradictions and plot holes, and quietly fixes them. It is the Scribe's work.
_Avoid_: Critic, judge, validator

**Scribe**:
The AI that keeps the story's record and reviews the world: State Upkeep after every reply, the Review of a new world and of each World Change, and, at each pause when the world moves on, new Lore, the folding of What an NPC Knows and the closing of settled Loose Ends and dropping of outdated known facts. It is the Narrator's model unless the player chooses another in Settings. The stored settings keep their old `review` names.
_Avoid_: Reviewer, Review model, Lore Keeper (Lore is the World Bible's)

**State Upkeep**:
A second AI call after each reply, the Scribe's, that brings the scene, cast, inventory, Story Time, known facts and Loose Ends in line with what the reply showed happening, and alone writes the Journal: its facts, its Loose Ends and its line on each person the PC knows, as it sees none of the secrets the Narrator does. It never changes a Plot Thread, which is World Moves On's. It records only changes the reply shows, never a detail to fit a passing mention. The Turn is saved once it finishes; if it fails, the Narrator's own state is kept.
_Avoid_: State sync, bookkeeping call

**World Moves On**:
A Narrator call at a natural pause (a Turn moving story time on by hours, a new day, a plan falling due a few replies after the last move, or every fifth reply), run after the Turn is saved while the player reads, that rewrites each Plot Thread's now by what its people did out of the PC's sight, leaving its truth as it is, true to the Lore Entries it names, removes one play has brought to an end, and adds one while fewer than three remain. The next Turn waits for it. It changes only the hidden Plot Threads, so the player never sees it, only its results in play.
_Avoid_: Off-screen turn, world tick

**Command**:
A Text Provider that is a program the player sets up, such as a provider's own command-line tool, in place of a server: it reads each prompt on its input and prints only the reply. As it runs a program, only Settings opened on the computer Ink & Thread runs on can set or change it. The Scribe uses it unless it has its own server.
_Avoid_: CLI provider, shell command (it runs with no shell)

**Check**:
A hidden test of a risky PC action against a difficulty the Narrator sets before the outcome is known. The player never sees a Check.
_Avoid_: Roll, skill check, saving throw

### World

**World Brief**:
The player's description of the world: written on the New Story form, where it seeds the World Bible, and editable in the Journal. A Snapshot holds the one in use.
_Avoid_: World details

**World Bible**:
The full generated world used by the Narrator, kept secret from the player.
_Avoid_: World details, lore

**Starting Hook**:
The optional opening situation chosen during story creation.
_Avoid_: Hook (alone)

**Tone**:
The mood and voice the Narrator tells the story in, such as wry or grim, picked on the New Story form and changed in the Journal. It is separate from the theme, which says what kind of world and story it is: a Tone says how it is told, and wins on that where the two differ, though the player's Model Instructions win over it. It never changes what happens or how a Check falls. The default, The world's own, sets none, leaving the mood the world was built with. Words only, never the pictures.
_Avoid_: Mood, style (the Art Style and Chat style), intensity

**Sparks**:
Starting points drawn at random in code each time a world is built, Regenerated or written by Pick for me: a pressure on the world, a constraint it lives under, a secret (never for Pick for me, whose boxes the player reads) and the first letters of invented names of people and places; and for a World Brief Pick for me writes from nothing, a real region whose land, livelihoods and sound of names it takes after, the kind of place the story centres on, and, for a theme that doesn't say, when it is set. The Narrator builds them in where the player's choices leave room, so the same idea doesn't build the same world. Unseen, with no setting.
_Avoid_: Seeds (the image seed and the bench's Seeded Choices)

**Important Characters**:
People besides the PC that the player wants in the story, added on the New Story form, each with a name and a description, up to ten. They are canon, and the world is built around them. Pick for me never writes them; only Enhance does, when the player presses it. A Save keeps them as Begin had them, with who was on the Cover, so a Cover Update pictures the same people.
_Avoid_: Cast, NPCs (those are whoever the story meets)

**Plot Thread**:
A secret storyline held by the Narrator that play can reveal. Its truth is what really happened, who is behind it and what is hidden, and changes only as play reveals it; its now is what its people have done out of the PC's sight, which is true, and its plan the one deed they mean to do next and by when, which has not happened until its time comes and play hasn't prevented it. World Moves On rewrites both.
_Avoid_: Hook (alone), plot

**Loose End**:
Something the PC knows is still unresolved, such as an unanswered question, a promise, a plan, an invitation or someone still missing. It stays on the list until play settles it, closed by State Upkeep as a reply settles it, or by the Scribe at a pause once several are open, never one just opened, and the player can read and edit it in the Journal.
_Avoid_: Open thread, Plot Thread (that is secret, and says where the story could go)

**Scene Memory**:
About 100 words on what happened in a batch of 20 older Messages, written by the Narrator before they leave the prompt and sent on every Turn after. The server records which Messages it covers. Only the player can change it, in the Journal. The player sees it as an **Old Memory**; code and prompts keep the name Scene Memory.
_Avoid_: Summary (that is the one rolling account of the whole story), Scene (that is a place and situation in the story)

**Story Summary**:
The one rolling account of the whole story so far, under 500 words, which the Narrator rewrites every fifth reply, leaning on the latest scenes, and reads on every Turn. The player reads and edits it in the Journal, beside the **Recent summary** of the last few scenes, which is written every Turn. Code and prompts call it the summary.
_Avoid_: Scene Memory (that covers one batch of older Messages)

**World Overview**:
A short, spoiler-free description of the world as the PC would plausibly know it.
_Avoid_: World Bible, World Brief

**Lore Entry**:
One titled, self-contained piece of the World Bible, either always available to the Narrator or activated by keywords.
_Avoid_: World Info, lorebook entry

### Player controls

**Rewrite**:
Regenerating the latest Narrator response using the player's feedback.
_Avoid_: Edit

**Edit** (of a response):
The player changing the words of the latest Narrator response themselves, after which the Narrator brings the state in line with them and writes nothing new. Any picture stays.
_Avoid_: Rewrite (that is the Narrator writing a new response from feedback)

**Regenerate**:
Replacing the latest Narrator response without feedback, or a world before play begins, which keeps the PC and every image already drawn.
_Avoid_: Retry, swipe

**World Change**:
A change to the world in the player's own plain words, to nudge the story or correct a mistake, given through Tell the Narrator in the Journal. The Narrator applies it to the World Bible, world rules and Plot Threads, and to the Journal's text where that no longer holds, including what the PC wears and carries and their status. The player never sees the inventory itself. The player sees only that it was done, and any change to the Journal.
_Avoid_: Edit (that is a change to text the player can read)

**Question**:
An out-of-character question the player puts to the Narrator through Ask the Narrator, like a player asking their DM. It is answered only with what the PC would know from their background and the story so far, never from Plot Threads, and never settles a Check. It is not a Turn: the Narrator never hears about it, nothing in the story changes, and the answer is not kept.
_Avoid_: World Change (that is Tell the Narrator, and changes the world)

**Director's Note** (retired from play, see ticket 31):
A standing out-of-character instruction to the Narrator for one Save, such as correcting a fact without Reverting.
_Avoid_: Author's Note, edit

**Choice**:
One of three things the Narrator offers the PC to say or do next, written with every Narrator response. Picking it sends it at once as the player's input, and the player can type their own move in the box under them instead. Whether they show is one Setting for every Story, Show Choices, on by default, which the Choices button by the text box also turns on and off. The latest response's Choices stay ready until the next Turn, shown or not.
_Avoid_: Option, suggestion, Play Mode, Free Text (Choices hidden is just Show Choices off)

**Chat style**:
How the Story shows Messages: Script, Prose or Bubbles. A fourth, the Stage box, is no longer offered; its code is kept, and a stored pick of it reads as Prose. It never changes how Chapters read in the Journal.

**Beat**:
One line of a Message, spoken or not, and what a Stage box shows at a time.

**New Version**:
A newer full release of Ink & Thread on GitHub, which a toast on every screen and Settings → Updates offer, and Install puts in place of the running program, which then restarts. Pre-releases are never offered.
_Avoid_: Update (that redraws a Cover or portrait)

**Tips**:
The first-time tour of the story screen: one bubble at a time over each tool by the box, then the tools under the latest response, once the first response is in. Shown once per install, recorded as `tipsSeen` in Settings, and shown again from the Reader's Guide.
_Avoid_: Tutorial, onboarding

**Reader's Guide**:
The player's help, opened from the Menu: what Ink & Thread is and how to use each part of it.
_Avoid_: Wiki, help, manual

**Model Instructions**:
The player's own global guidance to the Narrator, set in Settings and applying to every Save. Settings shows it as Extra Narrator Instructions, as the Narrator works without it.
_Avoid_: System prompt

**Setup**:
The Prologue: a page at a time through the main Settings, from the AI that writes the Story and its model to pictures and how the Story reads, each page saving only its own settings. Until a Narrator is set up, the Menu offers **Setup Ink & Thread** in place of New Story and Load Story.
_Avoid_: Wizard, onboarding

**Guided setup**:
Settings' way back into Setup at any time, starting from the choices already saved.

### State

**Snapshot**:
The complete, immutable story state belonging to a Message. Reverting to a Message restores its Snapshot.
_Avoid_: Save (a Snapshot is not a player-facing save)

**Story Time**:
The in-story date and time of day the PC is living in now, written in the world's own reckoning as the PC knows it, such as "3rd of Frostmoon" and "late evening". The world build picks the day the story starts on. The Narrator moves it on only when the player lets time pass, and the player can correct it in the Journal. Behind it the Narrator keeps a count of days since the Opening, which the player never sees.
_Avoid_: Clock, date (alone), current time

**Journal**:
The player-facing record of only what the PC knows or has encountered, where the player can edit that text. An edit lasts until a Revert to before it.
_Avoid_: Log

**Server Log**:
The app's own record of what it did, for tracing a problem: the console and `logs/inkandthread.log`. It holds no story text, only ids that lead to it in the Save, unless the player turns on Story in log to debug, when it also holds every prompt, reply and Image Prompt. It has nothing to do with the Chapters, which are the story's own record.
_Avoid_: Log (alone), debug log

**Usage**:
The tally, in Settings, of every request the app made to the AI, by day and by provider and model, text and pictures apart: how many, how many failed, the tokens for text, and the cost where the provider reports one. It holds no story text, belongs to no Save, and is kept for the whole install.
_Avoid_: Stats, Spend, Cost (alone)

**Log Level**:
How much goes in the Server Log: Error, Warning, Info or Verbose, each including the ones before it. A Default choice follows the build.
_Avoid_: Debug level

**Gallery**:
The part of the book holding every image the player may see, in three sections: Cover, Characters (the PC's portrait, then those of known NPCs) and Scenes (the Scene Images and the Requested Images). The player can delete an image in Scenes, and never the Cover or a portrait. Only the image goes: its Message and Snapshot stay, and a Revert doesn't bring it back.

**Revert**:
Returning to an earlier Message and permanently deleting everything after it.
_Avoid_: Undo, rollback

**Save**:
One story on disk, and the player-facing word for that file. Duplicating a Save is how the player branches a story.
_Avoid_: Branch, slot

**Start Over**:
Beginning a new Story with the New Story form's first step filled in from a Save, as that story began: its World Brief, Title, Theme, Starting Hook, PC and Important Characters. The later steps start fresh, so nothing played carries over and no picture: every one is drawn anew. It replaces any story the form was holding.
_Avoid_: Duplicate (which copies the whole Save), restart, template
