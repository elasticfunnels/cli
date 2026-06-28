import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { nonCollidingRel } from '../src/sync/sync';
import { withEfMeta } from '../src/sync/efMeta';

async function tmpBrand(): Promise<string> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-pullcol-'));
    const brandRoot = path.join(root, 'elasticfunnels');
    await fs.promises.mkdir(path.join(brandRoot, 'components'), { recursive: true });
    return brandRoot;
}

// nonCollidingRel only reads ctx.rt.brandRoot.
const ctxFor = (brandRoot: string) => ({ rt: { brandRoot } } as never);

test('nonCollidingRel disambiguates when a different id already holds the path', async () => {
    const brandRoot = await tmpBrand();
    try {
        await fs.promises.writeFile(
            path.join(brandRoot, 'components', 'dup.ef'),
            withEfMeta({ v: 1, type: 'component', brandId: 7, id: 100, path: 'components/dup.ef' }, '<p>a</p>'),
        );
        // A different id colliding on the same path → id-suffixed.
        assert.equal(await nonCollidingRel(ctxFor(brandRoot), 'components/dup.ef', 200, 'component'), 'components/dup-200.ef');
        // Same id (normal re-pull) → unchanged (idempotent, no false collision).
        assert.equal(await nonCollidingRel(ctxFor(brandRoot), 'components/dup.ef', 100, 'component'), 'components/dup.ef');
        // Unoccupied path → unchanged.
        assert.equal(await nonCollidingRel(ctxFor(brandRoot), 'components/free.ef', 5, 'component'), 'components/free.ef');
    } finally {
        await fs.promises.rm(path.dirname(brandRoot), { recursive: true, force: true });
    }
});

test('nonCollidingRel treats an efmeta-less file as free (no false collision)', async () => {
    const brandRoot = await tmpBrand();
    try {
        await fs.promises.writeFile(path.join(brandRoot, 'components', 'plain.ef'), '<p>no meta</p>');
        assert.equal(await nonCollidingRel(ctxFor(brandRoot), 'components/plain.ef', 9, 'component'), 'components/plain.ef');
    } finally {
        await fs.promises.rm(path.dirname(brandRoot), { recursive: true, force: true });
    }
});
