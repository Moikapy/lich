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

interface BunPipeSpawned {
  stdin: { write(data: string): number; flush(): void | Promise<void> };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
  unref(): void;
}

interface BunSpawn {
  (cmd: string[], options: { stdin: "ignore"; stdout: "pipe"; stderr: "pipe" }): BunSpawned;
  (cmd: string[], options: { stdin: "pipe"; stdout: "pipe"; stderr: "pipe"; env?: Record<string, string> }): BunPipeSpawned;
}

declare const Bun: {
  spawn: BunSpawn;
};
