# One server, two hosts

The server's code runs in two places: under Bun, as the download and the self-hosted server, and inside the player's own browser, as the phone app, a static site with no server behind it. The routes, the Narrator, the Saves and everything else in `src/` are the same code in both. Only three things differ, all outside the shared code:

- **Serving.** `server-routes.ts` builds the parts and the route tables both hosts serve. `rest-api.ts` puts them on `Bun.serve`, with the page, ComfyUI, Quit and updates. In the phone app, `src/browser/server-worker.ts` runs them in a dedicated worker of the page, and a service worker (`src/browser/sw.ts`) sends it every request that isn't one of the build's own files. Requests and answers cross as messages, with the answer in chunks, so a Turn's events still stream.
- **Storage.** The phone build swaps `bun:sqlite`, `node:fs`, `node:async_hooks` and `node:zlib` for the versions in `src/browser/` at bundle time (`scripts/phone-aliases.ts`). Saves stay SQLite files, in the browser's storage through SQLite's WASM build and its SAH pool. Settings, world drafts and file times sit in one app SQLite file there. The server's source keeps its imports, so the desktop build doesn't change.
- **What each host offers.** The desktop adds ComfyUI, the local command, Local / OpenAI server text, Wiro, the updater and Quit. The phone app offers hosted APIs only, called straight from the device. Shared code never imports the desktop-only modules (`test/desktop-only.test.ts`).

The phone app holds a Web Lock, so only one tab has the Saves open; a second is told why. Its log goes to the app file through `logLinesTo`, as the desktop's goes to `logs/`. `e2e/phone-storage.spec.ts` runs the same pass through the Saves on Bun and in the browser and requires the same result. `e2e/phone-play.spec.ts` plays the phone build on the fake Narrator.

## Considered Options

A hosted server for many players would need accounts, would hold their keys and stories, and would make the project a platform with content rules, against its pitch. An app-store app brings the stores' content rules. Threading storage interfaces through the server code would mean more code, and both hosts changing with every storage change; the bundle-time swap keeps the server code as it is. Its risk, a server change using a file call the stand-in lacks, fails the phone build rather than running wrong, as the stand-ins export only what the server uses and throw on cases they don't handle.
