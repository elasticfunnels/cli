import * as fs from 'fs';
import * as path from 'path';
import { CliError, ExitCode } from './exit';
import { safeJoinBrandRoot } from '../sync/paths';

function isUnderBrandRoot(brandRoot: string, abs: string): boolean {
    const root = path.resolve(brandRoot);
    const a = path.resolve(abs);
    return a === root || a.startsWith(root + path.sep);
}

function misplacedHint(brandRoot: string, wrongAbs: string): string {
    const syncParent = path.dirname(path.resolve(brandRoot));
    const rel = path.relative(syncParent, path.resolve(wrongAbs)).split(path.sep).join('/');
    return (
        `File exists at ${wrongAbs} but this brand syncs under ${brandRoot}. ` +
        `Pages belong in …/${path.basename(brandRoot)}/pages/, not …/${rel.split('/')[0]}/pages/ when that skips the brand id folder. ` +
        `Move the file or run: ef push pages/… (path relative to the brand folder).`
    );
}

/**
 * Resolve a user-supplied path for commands that need an on-disk file under
 * the brand sync tree (`<project>/<syncRoot>/…` with optional `<brandId>/`
 * when `syncLayout` is `nested`).
 *
 * Order:
 * 1. Absolute paths as given (must lie under brand root).
 * 2. Relative to cwd (only if under brand root when other hits exist).
 * 3. Relative to brand root (so `ef diff pages/foo.ef` works from repo root).
 * 4. Shorthand: page slug (`index2` → `pages/index2.ef`), bare `.ef` name,
 *    and `pages/foo` without extension.
 * 5. Strip a leading sync-root segment when the user passes
 *    `elasticfunnels/pages/...` (segment from `config.syncRoot`) so it maps
 *    into `brandRoot/pages/...` instead of a mistaken sibling folder.
 */
function syncRootLeadSegment(syncRoot: string): string {
    const seg = syncRoot.replace(/\\/g, '/').split('/').filter(Boolean);
    return seg[0] ?? 'elasticfunnels';
}

export async function resolveSyncPathInput(brandRoot: string, raw: string, syncRoot: string): Promise<string> {
    const tryStat = async (abs: string): Promise<string | null> => {
        try {
            await fs.promises.stat(abs);
            return path.normalize(abs);
        } catch {
            return null;
        }
    };

    if (path.isAbsolute(raw)) {
        const hit = await tryStat(raw);
        if (!hit) throw new CliError(ExitCode.NotFound, `Path not found: ${raw}`);
        if (!isUnderBrandRoot(brandRoot, hit)) {
            throw new CliError(ExitCode.Validation, misplacedHint(brandRoot, hit));
        }
        return hit;
    }

    const candidates: string[] = [];
    const pushUnique = (abs: string) => {
        const n = path.normalize(abs);
        if (!candidates.some((c) => c === n)) candidates.push(n);
    };

    pushUnique(path.resolve(process.cwd(), raw));
    pushUnique(path.resolve(brandRoot, raw));

    const rel = raw.replace(/\\/g, '/').replace(/^\/+/, '');
    const lower = rel.toLowerCase();

    const lead = syncRootLeadSegment(syncRoot);
    const parts = rel.split('/').filter(Boolean);
    if (parts[0] === lead && parts.length > 1) {
        pushUnique(safeJoinBrandRoot(brandRoot, parts.slice(1).join('/')));
    }

    if (lower.endsWith('.ef') && !rel.includes('/')) {
        pushUnique(safeJoinBrandRoot(brandRoot, `pages/${rel}`));
        pushUnique(safeJoinBrandRoot(brandRoot, `components/${rel}`));
    }

    if (!rel.includes('/') && !lower.endsWith('.ef')) {
        pushUnique(safeJoinBrandRoot(brandRoot, `pages/${rel}.ef`));
        pushUnique(safeJoinBrandRoot(brandRoot, `components/${rel}.ef`));
    }

    if (rel.startsWith('pages/') && !lower.endsWith('.ef')) {
        pushUnique(safeJoinBrandRoot(brandRoot, `${rel}.ef`));
    }
    if (rel.startsWith('components/') && !lower.endsWith('.ef')) {
        pushUnique(safeJoinBrandRoot(brandRoot, `${rel}.ef`));
    }

    const hits: string[] = [];
    for (const abs of candidates) {
        const hit = await tryStat(abs);
        if (hit && !hits.includes(hit)) hits.push(hit);
    }

    const underBrand = hits.filter((h) => isUnderBrandRoot(brandRoot, h));
    if (underBrand.length > 0) return underBrand[0];

    if (hits.length > 0) {
        throw new CliError(ExitCode.Validation, misplacedHint(brandRoot, hits[0]));
    }

    throw new CliError(ExitCode.NotFound, `Path not found: ${raw}`);
}
