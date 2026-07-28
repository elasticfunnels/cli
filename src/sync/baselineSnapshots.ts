// Baseline snapshots — the common-ancestor BODY captured at the last pull/push,
// stored at `<brandRoot>/.ef-state/snapshots/<type>/<id>.bin`. This is the base
// for a 3-way merge (`ef pull --merge`) and the trailing-whitespace self-heal in
// drift detection. Layout matches the VS Code extension so the two tools share
// bases on the same folder.

import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomic } from '../utils/fs';

export type SnapshotType = 'page' | 'component' | 'script' | 'asset' | 'templatePage' | 'pageEvents';

export function snapshotPath(brandRoot: string, type: SnapshotType, id: number | string): string {
    return path.join(brandRoot, '.ef-state', 'snapshots', type, `${id}.bin`);
}

export async function readSnapshot(brandRoot: string, type: SnapshotType, id: number | string): Promise<Buffer | null> {
    try {
        return await fs.promises.readFile(snapshotPath(brandRoot, type, id));
    } catch {
        return null;
    }
}

/** Persist the common-ancestor body. Best-effort: a failed cache write must not
 *  break a pull/push (the next pull re-establishes the base). */
export async function writeSnapshot(brandRoot: string, type: SnapshotType, id: number | string, bytes: Buffer | Uint8Array): Promise<void> {
    try {
        const p = snapshotPath(brandRoot, type, id);
        await fs.promises.mkdir(path.dirname(p), { recursive: true });
        await writeFileAtomic(p, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
    } catch {
        /* tolerated — snapshots are a regenerable cache */
    }
}

export async function deleteSnapshot(brandRoot: string, type: SnapshotType, id: number | string): Promise<void> {
    try {
        await fs.promises.unlink(snapshotPath(brandRoot, type, id));
    } catch {
        /* tolerate missing */
    }
}
