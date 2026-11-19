# A Plot Thread's truth and now

Each Plot Thread has two parts. Its truth (`plotThreads`) is what really happened, who is behind it, what they want and what is hidden. Its now (`threadsNow`, by truth) is what its people are doing and will do next out of the PC's sight. World Moves On rewrites only the now, and is given the truth to read. A Turn may amend a truth only with what its reply revealed, and only when the reply names someone the thread names. World Moves On writes a truth only for a thread it adds. A World Change, the player's own words, may rewrite a truth, and that thread's now then starts empty.

Before this, a thread was one text that every move rewrote whole. In every bench run, rewrites lost who was behind a thread and what it hid, or contradicted each other. The checks built to stop that (names kept, a thread's secret words kept, no retelling of the scene in play) then refused fair rewrites, which left threads stale. With the truth out of a rewrite's reach those checks had nothing left to protect, so they were removed.

A Save from before keeps its threads' text as their truths, with no now, as a missing state section is filled with its empty value when the Save opens.

## Considered Options

A list of thread objects, `{ truth, now }`, would have changed every place that quotes a thread by its text: Turns, World Changes, the world's review and every stored edit. Keeping the truths as the list and the nows beside them left all of those as they were.
