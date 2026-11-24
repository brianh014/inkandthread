import { errorType, log } from "./logger";

type Build = { id: string; done: Promise<string>; stop: AbortController; finished: boolean };

/**
 * The worlds being built, one per New Story form, which outlive the requests that started them, so a page that loses its
 * connection or reloads asks for the same build by its id rather than paying for another.
 * shortcut: held in memory, so a restart ends them, keep them on disk if players lose builds that way.
 */
export function worldBuilds() {
  const builds = new Map<string, Build>();
  // Builds cancelled before they were asked for, as a cancel can overtake the request it cancels.
  // shortcut: one whose request never comes stays here, clear them by age if they add up.
  const cancelled = new Set<string>();

  function find(world: string, id: string) {
    const build = builds.get(world);
    return build?.id === id ? build : undefined;
  }

  return {
    find,

    /** The same build asked for again is the one already there. Another build of the same world stops it. `work` answers with the overview, and must check its signal before it changes anything held. */
    start(world: string, id: string, work: (signal: AbortSignal) => Promise<string>) {
      const same = find(world, id);
      if (same) return same;
      builds.get(world)?.stop.abort();
      const stop = new AbortController();
      if (cancelled.delete(id)) stop.abort();
      const done = (async () => {
        stop.signal.throwIfAborted();
        return await work(stop.signal);
      })();
      const build: Build = { id, done, stop, finished: false };
      builds.set(world, build);
      const ended = (outcome: string, fields = {}) => {
        build.finished = true;
        log.info("world", "World build ended", { world, build: id, outcome, ...fields });
      };
      // Heard here, as a page that lost its connection may never ask.
      done.then(
        () => ended("built"),
        (error) => ended(stop.signal.aborted ? "stopped" : "failed", errorType(error)),
      );
      return build;
    },

    cancel(world: string, id: string) {
      const build = find(world, id);
      if (build) build.stop.abort();
      else cancelled.add(id);
      log.info("world", "World build cancelled", { world, build: id, running: !!build && !build.finished });
    },

    /** The form is done with its world. */
    drop(world: string) {
      builds.get(world)?.stop.abort();
      builds.delete(world);
    },

    busy: () => [...builds.values()].some(({ finished }) => !finished),
  };
}
