// Cancellation bounds local waiting even when a trusted adapter neglects its signal. The
// underlying read may finish later; its result is ignored and no further IR nodes consume it.
export async function bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let listener: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    listener = () => reject(new DOMException('Operation aborted.', 'AbortError'));
    signal.addEventListener('abort', listener, { once: true });
  });
  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    signal.removeEventListener('abort', listener);
  }
}
