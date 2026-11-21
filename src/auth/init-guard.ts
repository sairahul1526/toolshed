/**
 * A cached start-up that cannot hang forever.
 *
 * On Workers, a promise created while serving one request can stall for good if that request is
 * aborted before it settles. A lazily cached "init" promise then freezes every later request in
 * the same isolate. So each caller waits a bounded time, and a stalled start-up is thrown away and
 * rebuilt once instead of being awaited again.
 */
export interface Guarded<T> {
  get(): Promise<T>;
}

class StartTimeout extends Error {}

function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new StartTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * `start` builds the value. It is called again only when the previous try failed or stalled.
 * A start-up that throws is not cached, so a fixed setting takes effect on the next request.
 */
export function guardInit<T>(start: () => Promise<T>, timeoutMs = 3000): Guarded<T> {
  let pending: Promise<T> | null = null;
  let ready: { value: T } | null = null;

  return {
    async get() {
      if (ready) return ready.value;
      for (let attempt = 0; attempt < 2; attempt++) {
        const mine = (pending ??= start());
        try {
          const value = await settleWithin(mine, timeoutMs);
          ready = { value };
          return value;
        } catch (err) {
          if (pending === mine) pending = null;
          if (!(err instanceof StartTimeout)) throw err;
        }
      }
      throw new Error('Sign-in did not start in time.');
    },
  };
}
