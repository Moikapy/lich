export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error("sleep_aborted"));
      return;
    }
    const on_abort = (): void => {
      clearTimeout(timer);
      reject(new Error("sleep_aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", on_abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", on_abort, { once: true });
  });
}