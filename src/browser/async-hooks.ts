/**
 * `node:async_hooks` for the phone build, which browsers lack. The logger keeps each request's route and Save here, so on
 * the phone a line inside a request doesn't carry them.
 * shortcut: lines lose `route` and `save` on the phone; ticket 10 of .scratch/phone-app passes them explicitly.
 */
export class AsyncLocalStorage<T> {
  getStore(): T | undefined {
    return undefined;
  }
  run<R>(_store: T, fn: () => R): R {
    return fn();
  }
}
