export {};
// The server reads `process.env` (NODE_ENV and a few test switches), which a browser lacks. Imported first by the worker.
const scope = globalThis as { process?: { env: Record<string, string | undefined> } };
scope.process ??= { env: { NODE_ENV: "production" } };
