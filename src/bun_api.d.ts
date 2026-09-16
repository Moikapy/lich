/**
 * Narrow Bun APIs this CLI calls. @types/bun is installed, but listing it in
 * tsconfig `types` adds a required `fetch.preconnect` and breaks Node fetch mocks.
 * https://bun.com/docs/guides/util/detect-bun.md
 * https://bun.com/docs/runtime/child-process.md
 */
interface ImportMeta {
  readonly main?: boolean;
}

interface ProcessVersions {
  bun?: string;
}

interface BunSpawned {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
}

declare const Bun: {
  spawn(cmd: string[], options: { stdin: "ignore"; stdout: "pipe"; stderr: "pipe" }): BunSpawned;
};
