/**
 * Library entry point for programmatic callers — `@elasticfunnels/cli/agent`.
 *
 * Deliberately a subpath rather than the package root: the root is the `ef`
 * command, and this surface has different rules. It takes credentials as
 * arguments instead of reading `.ef/auth`, defaults every write to a draft, and
 * is the only place `bearer` auth is reachable. Keeping it behind `/agent` means
 * a human running `ef` cannot stumble into it, and the two can be documented and
 * versioned as what they are: one package, two audiences.
 *
 * The export list is intentionally narrow. Everything here is something a
 * caller cannot do through the command surface; anything they *can* do belongs
 * in a command, not in an API we would then have to keep stable forever.
 */

export {
    openBrandWorkspace,
    materializeBrand,
    pushDir,
} from './lib/agentWorkspace';

export type {
    BrandCredentials,
    WorkspaceOptions,
    PushDirOptions,
} from './lib/agentWorkspace';

// On-demand asset access + workspace tidy-up.
export { pullAssets, pullOneAsset, cleanupPulledAssets } from './sync/sync';

// Refresh one page mid-session without re-materializing the brand, and read the
// efmeta identity line a caller must never rewrite by hand.
export { pullPage } from './sync/sync';
export { parseEfMeta } from './sync/efMeta';
export type { EfMeta } from './sync/efMeta';

// Needed to type a SyncContext handed back to pushDir.
export type { SyncContext, PushResult } from './sync/sync';
export type { EfAuth } from './utils/store';
