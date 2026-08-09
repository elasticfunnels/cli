import * as fs from 'fs';
import { CliError, ExitCode } from './exit';
import { authPathFor, findProjectRoot } from './store';

/**
 * Telling the user what to do about a rejected credential.
 *
 * The CLI accepts two kinds, and they fail for completely different reasons and
 * have completely different fixes:
 *
 *   efc_…   a per-device token from the browser/pairing flow. Rejected because
 *           it was revoked under "Connected devices", or it expired. Fix: sign
 *           in again — nothing to look up, nothing to copy.
 *   other   the legacy per-(user, brand) EF-Access-Key. Rejected because it is
 *           wrong for this brand, or was regenerated. Fix: go read the new one
 *           off the brand's API settings page.
 *
 * Saying "make sure it's a valid API key" to someone whose device was
 * disconnected sends them hunting for a key they never had.
 */

/** Tokens minted by the device-authorization and pairing flows carry this prefix. */
const DEVICE_TOKEN_PREFIX = 'efc_';

export type CredentialKind = 'device' | 'legacy';

export function credentialKind(apiKey: string): CredentialKind {
    return apiKey.trim().startsWith(DEVICE_TOKEN_PREFIX) ? 'device' : 'legacy';
}

/** The actionable sentence for a rejected credential of this kind. */
export function reauthHint(kind: CredentialKind): string {
    return kind === 'device'
        ? 'This device\'s access was revoked or has expired (Settings → account menu → Connected devices). Run "ef login" to sign in again — your files and brand binding are kept.'
        : 'The brand API key was rejected. It may have been regenerated, or it belongs to a different brand — get the current one from Settings → All Settings → API. Or run "ef login" to switch this folder to a per-device token instead.';
}

/**
 * Read the stored credential's kind without going through `loadRuntime`.
 *
 * Used on the error path, where the runtime may never have loaded (or may be
 * the very thing that failed), so this stays synchronous and swallows
 * everything — a missing or unreadable auth file just means we cannot say
 * anything more specific than the generic message.
 */
export function storedCredentialKind(startDir?: string): CredentialKind | null {
    try {
        const root = findProjectRoot(startDir);
        if (!root) return null;
        const raw = fs.readFileSync(authPathFor(root), 'utf8').trim();
        return raw ? credentialKind(raw) : null;
    } catch {
        return null;
    }
}

/**
 * Append the right "here is how to fix it" line to an auth failure.
 *
 * Applied once at the top-level dispatcher rather than at each of the ~50 call
 * sites that can raise a 401, so every endpoint gets the same guidance and none
 * can drift out of date.
 */
export function augmentAuthError(err: CliError): CliError {
    if (err.code !== ExitCode.Auth) return err;
    const kind = storedCredentialKind();
    if (!kind) return err;
    const hint = reauthHint(kind);
    // Some messages already point at the fix (e.g. "Run ef init"); don't stack
    // a second, contradictory instruction on top.
    if (err.message.includes('ef login') || err.message.includes('ef init')) return err;
    return new CliError(err.code, `${err.message}\n  ${hint}`);
}
