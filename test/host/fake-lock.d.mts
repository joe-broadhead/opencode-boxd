// The types of `fake-lock.mjs`, for the TypeScript side of the fakes.
export declare const LOCK_WAIT_MS: number
/** Takes the lock, waiting up to `LOCK_WAIT_MS` and taking over one whose holder is dead. */
export declare function acquire(lock: string): void
export declare function release(lock: string): void
