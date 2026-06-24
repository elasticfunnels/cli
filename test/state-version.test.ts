import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SyncStateFile, STATE_VERSION } from '../src/sync/stateFile';

async function tmpDir(): Promise<string> {
    return await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-state-'));
}

test('SyncStateFile starts at version=' + STATE_VERSION + ' for fresh dirs', async () => {
    const root = await tmpDir();
    try {
        const sf = await SyncStateFile.load(root, 7);
        assert.equal(sf.brandId, 7);
        assert.equal(sf.isVersionTooNew(), false);
        assert.equal(sf.getLoadedVersion(), STATE_VERSION);
        await sf.save();
        const raw = JSON.parse(await fs.promises.readFile(path.join(root, '.ef-state.json'), 'utf8'));
        assert.equal(raw.version, STATE_VERSION);
        assert.equal(raw.brandId, 7);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('save() refuses to overwrite a state file written by a newer CLI', async () => {
    const root = await tmpDir();
    try {
        const future = {
            version: STATE_VERSION + 99,
            brandId: 7,
            pages: {},
            components: {},
            scripts: {},
            assets: {},
            templatePages: {},
            futureField: { hello: 'world' },
        };
        await fs.promises.writeFile(path.join(root, '.ef-state.json'), JSON.stringify(future, null, 2));

        const sf = await SyncStateFile.load(root, 7);
        assert.equal(sf.isVersionTooNew(), true);
        assert.equal(sf.getLoadedVersion(), STATE_VERSION + 99);

        // Mutating in-memory must not persist when version is too new.
        sf.setEntry('page', { path: 'pages/home.ef', id: 1, type: 'page' });
        await sf.save();

        const reread = JSON.parse(await fs.promises.readFile(path.join(root, '.ef-state.json'), 'utf8'));
        assert.equal(reread.version, STATE_VERSION + 99);
        assert.deepEqual(reread.futureField, { hello: 'world' }, 'future fields must be preserved verbatim');
        assert.deepEqual(reread.pages, {}, 'in-memory mutation must not have been persisted');
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('save() preserves unknown top-level fields on round-trip', async () => {
    const root = await tmpDir();
    try {
        const initial = {
            version: STATE_VERSION,
            brandId: 7,
            pages: {},
            components: {},
            scripts: {},
            assets: {},
            templatePages: {},
            mySidecar: { foo: 'bar', n: 3 },
        };
        await fs.promises.writeFile(path.join(root, '.ef-state.json'), JSON.stringify(initial, null, 2));

        const sf = await SyncStateFile.load(root, 7);
        sf.setEntry('page', {
            path: 'pages/home.ef', id: 1, type: 'page',
            revisionId: 5, contentHash: 'abc', updatedAt: '2026-01-01T00:00:00Z',
        });
        await sf.save();

        const reread = JSON.parse(await fs.promises.readFile(path.join(root, '.ef-state.json'), 'utf8'));
        assert.deepEqual(reread.mySidecar, { foo: 'bar', n: 3 }, 'unknown sidecar must survive');
        assert.equal(reread.pages['pages/home.ef'].id, 1);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('setEntry mirrors CLI state into extension-compatible buckets', async () => {
    const root = await tmpDir();
    try {
        const sf = await SyncStateFile.load(root, 7);
        sf.setEntry('asset', {
            path: 'assets/main.css',
            id: 44,
            type: 'asset',
            contentHash: 'new-hash',
            updatedAt: '2026-01-02T00:00:00Z',
            serverUpdatedAt: '2026-01-02T00:00:00Z',
        });
        sf.setEntry('page', {
            path: 'pages/home.ef',
            id: 11,
            type: 'page',
            revisionId: 123,
            contentHash: 'page-hash',
            updatedAt: '2026-01-03T00:00:00Z',
        });
        await sf.save();

        const reread = JSON.parse(await fs.promises.readFile(path.join(root, '.ef-state.json'), 'utf8'));
        assert.equal(reread.assetsById['44'].path, 'assets/main.css');
        assert.equal(reread.assetsById['44'].contentHash, 'new-hash');
        assert.equal(reread.pathToAssetId['assets/main.css'], 44);
        assert.equal(reread.pagesById['11'].path, 'pages/home.ef');
        assert.equal(reread.pagesById['11'].revisionId, 123);
        assert.equal(reread.pagesById['11'].contentHash, 'page-hash');
        assert.equal(reread.pathToPageId['pages/home.ef'], 11);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('setEntry updates stale extension mirror paths for the same id', async () => {
    const root = await tmpDir();
    try {
        const initial = {
            version: STATE_VERSION,
            brandId: 7,
            pages: {},
            components: {},
            scripts: {},
            assets: {},
            templatePages: {},
            assetsById: {
                '44': {
                    path: 'assets/old.css',
                    updatedAt: '2026-01-01T00:00:00Z',
                    contentHash: 'old-hash',
                    serverUpdatedAt: '2026-01-01T00:00:00Z',
                },
            },
            pathToAssetId: { 'assets/old.css': 44 },
        };
        await fs.promises.writeFile(path.join(root, '.ef-state.json'), JSON.stringify(initial, null, 2));

        const sf = await SyncStateFile.load(root, 7);
        sf.setEntry('asset', {
            path: 'assets/main.css',
            id: 44,
            type: 'asset',
            contentHash: 'new-hash',
            updatedAt: '2026-01-02T00:00:00Z',
        });
        await sf.save();

        const reread = JSON.parse(await fs.promises.readFile(path.join(root, '.ef-state.json'), 'utf8'));
        assert.equal(reread.assetsById['44'].path, 'assets/main.css');
        assert.equal(reread.assetsById['44'].contentHash, 'new-hash');
        assert.equal(reread.pathToAssetId['assets/main.css'], 44);
        assert.equal(reread.pathToAssetId['assets/old.css'], undefined);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('save() can update extension schema v2 state without downgrading it', async () => {
    const root = await tmpDir();
    try {
        const initial = {
            version: 2,
            brandId: 7,
            updatedAt: '2026-01-01T00:00:00Z',
            pages: {},
            components: {},
            scripts: {},
            assets: {},
            templatePages: {},
            assetsById: {},
            pathToAssetId: {},
        };
        await fs.promises.writeFile(path.join(root, '.ef-state.json'), JSON.stringify(initial, null, 2));

        const sf = await SyncStateFile.load(root, 7);
        assert.equal(sf.isVersionTooNew(), false);
        sf.setEntry('asset', {
            path: 'assets/main.css',
            id: 44,
            type: 'asset',
            contentHash: 'new-hash',
            updatedAt: '2026-01-02T00:00:00Z',
        });
        await sf.save();

        const reread = JSON.parse(await fs.promises.readFile(path.join(root, '.ef-state.json'), 'utf8'));
        assert.equal(reread.version, 2);
        assert.equal(reread.assetsById['44'].contentHash, 'new-hash');
        assert.equal(reread.assets['assets/main.css'].contentHash, 'new-hash');
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('load() rebuilds CLI buckets from extension id-keyed buckets', async () => {
    const root = await tmpDir();
    try {
        // A file written by the VS Code extension: id-keyed v2 buckets only,
        // no path-keyed v1 `pages`/`assets` buckets.
        const extensionWritten = {
            version: 2,
            brandId: 7,
            updatedAt: '2026-01-01T00:00:00Z',
            lastSyncAt: '2026-01-01T00:00:00Z',
            pagesById: {
                '11': {
                    path: 'pages/home.ef',
                    revisionId: 123,
                    contentHash: 'page-hash',
                    updatedAt: '2026-01-03T00:00:00Z',
                    serverUpdatedAt: '2026-01-03T00:00:00Z',
                },
            },
            pathToPageId: { 'pages/home.ef': 11 },
            assetsById: {
                '44': { path: 'assets/main.css', contentHash: 'asset-hash', serverUpdatedAt: '2026-01-02T00:00:00Z' },
            },
            pathToAssetId: { 'assets/main.css': 44 },
        };
        await fs.promises.writeFile(path.join(root, '.ef-state.json'), JSON.stringify(extensionWritten, null, 2));

        const sf = await SyncStateFile.load(root, 7);
        // The baseline must be visible to the CLI via its path-keyed view.
        const page = sf.getByPath('page', 'pages/home.ef');
        assert.ok(page, 'expected the page to be recovered from pagesById');
        assert.equal(page?.id, 11);
        assert.equal(page?.revisionId, 123);
        assert.equal(page?.contentHash, 'page-hash');
        assert.equal(page?.serverUpdatedAt, '2026-01-03T00:00:00Z');
        const asset = sf.getById('asset', 44);
        assert.equal(asset?.path, 'assets/main.css');
        assert.equal(asset?.contentHash, 'asset-hash');

        // A CLI save must keep both schemas present and consistent.
        await sf.save();
        const reread = JSON.parse(await fs.promises.readFile(path.join(root, '.ef-state.json'), 'utf8'));
        assert.equal(reread.version, 2, 'must not downgrade the extension version');
        assert.equal(reread.pages['pages/home.ef'].id, 11);
        assert.equal(reread.pagesById['11'].contentHash, 'page-hash', 'extension buckets must survive');
        assert.equal(reread.pathToPageId['pages/home.ef'], 11);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('load() prefers CLI v1 entries over extension buckets for the same id', async () => {
    const root = await tmpDir();
    try {
        // Both schemas present but the extension bucket is stale for id 11.
        const mixed = {
            version: 2,
            brandId: 7,
            pages: { 'pages/home.ef': { path: 'pages/home.ef', id: 11, type: 'page', contentHash: 'fresh' } },
            components: {}, scripts: {}, assets: {}, templatePages: {},
            pagesById: { '11': { path: 'pages/home.ef', contentHash: 'stale' } },
            pathToPageId: { 'pages/home.ef': 11 },
        };
        await fs.promises.writeFile(path.join(root, '.ef-state.json'), JSON.stringify(mixed, null, 2));

        const sf = await SyncStateFile.load(root, 7);
        const page = sf.getByPath('page', 'pages/home.ef');
        assert.equal(page?.contentHash, 'fresh', 'CLI v1 entry must win over a stale extension bucket');
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('load() recovers from .bak when the primary is empty', async () => {
    const root = await tmpDir();
    try {
        // Primary is corrupt/empty; backup is a valid state.
        const valid = {
            version: STATE_VERSION,
            brandId: 9,
            pages: { 'pages/x.ef': { path: 'pages/x.ef', id: 42, type: 'page' } },
            components: {}, scripts: {}, assets: {}, templatePages: {},
        };
        await fs.promises.writeFile(path.join(root, '.ef-state.json'), '');
        await fs.promises.writeFile(path.join(root, '.ef-state.json.bak'), JSON.stringify(valid));

        const sf = await SyncStateFile.load(root, 9);
        const e = sf.getByPath('page', 'pages/x.ef');
        assert.ok(e, 'expected to recover the page entry from .bak');
        assert.equal(e?.id, 42);
        // Primary should now be promoted to the recovered content.
        const reread = JSON.parse(await fs.promises.readFile(path.join(root, '.ef-state.json'), 'utf8'));
        assert.equal(reread.brandId, 9);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('save() writes a .bak alongside the primary state file', async () => {
    const root = await tmpDir();
    try {
        // First save creates the primary; no .bak yet.
        const sf = await SyncStateFile.load(root, 1);
        sf.setEntry('page', { path: 'pages/a.ef', id: 1, type: 'page' });
        await sf.save();
        assert.equal(fs.existsSync(path.join(root, '.ef-state.json.bak')), false);

        // Second save backs the previous primary up before overwriting.
        sf.setEntry('page', { path: 'pages/b.ef', id: 2, type: 'page' });
        await sf.save();
        assert.ok(fs.existsSync(path.join(root, '.ef-state.json.bak')), 'expected .bak to be written on second save');
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
