// Stable exit codes. Documented in the README and unlikely to change so
// callers (Claude Code, CI) can branch reliably.
export const ExitCode = {
    /** Command completed successfully. */
    Ok: 0,
    /** Generic error fallback. Try to use a more specific code instead. */
    Error: 1,
    /** Bad CLI usage: unknown flag, missing required argument, validation. */
    Validation: 2,
    /** No active project config / not logged in / invalid API key. */
    Auth: 3,
    /** HTTP 409 / revision conflict / file changed online while you had it. */
    Conflict: 4,
    /** Network failure: DNS, timeout, connection refused. */
    Network: 5,
    /** Server-side 5xx or unexpected backend response. */
    Server: 6,
    /** File the user pointed at does not exist or cannot be read. */
    NotFound: 7,
} as const;

export type ExitCodeValue = typeof ExitCode[keyof typeof ExitCode];

/**
 * Throwable that carries a stable exit code. The CLI dispatcher catches these
 * and passes the code straight to `process.exit`. Use this instead of bare
 * `throw new Error(...)` whenever you want the exit code to be something
 * other than the generic "1".
 */
export class CliError extends Error {
    constructor(public readonly code: ExitCodeValue, message: string) {
        super(message);
        this.name = 'CliError';
    }
}
