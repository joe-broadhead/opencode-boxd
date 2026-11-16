// The types of `fake-lock.mjs`, for the TypeScript side of the fakes.
export declare const LOCK_WAIT_MS: number
/** True for a live process (of any user). */
export declare function alive(pid: number | undefined): boolean
/** Puts a lock with this owner text in place in one rename; false when a lock is already there. */
export declare function plant(lock: string, owner: string): boolean
/** Takes the lock, waiting up to `waitMs` (default `LOCK_WAIT_MS`) and taking over one whose holder is dead. */
export declare function acquire(lock: string, options?: { readonly waitMs?: number }): void
/** Gives the lock back, only while it is still this acquire's. */
export declare function release(lock: string): void
