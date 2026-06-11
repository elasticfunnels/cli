import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeFileAtomic } from '../src/utils/fs';

async function tmpDir(): Promise<string> {
    return await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-atomic-'));
}

test('writeFileAtomic writes new files via temp+rename', async () => {
    const dir = await tmpDir();
    try {
        const target = path.join(dir, 'sub', 'a.txt');
        await writeFileAtomic(target, 'hello');
        assert.equal(await fs.promises.readFile(target, 'utf8'), 'hello');
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
});

test('writeFileAtomic does not leave .tmp- files behind on success', async () => {
    const dir = await tmpDir();
    try {
        const target = path.join(dir, 'a.txt');
        await writeFileAtomic(target, 'first');
        await writeFileAtomic(target, 'second');
        await writeFileAtomic(target, Buffer.from('third'));
        const entries = await fs.promises.readdir(dir);
        const leaked = entries.filter(e => e.includes('.tmp-'));
        assert.deepEqual(leaked, [], `unexpected leaked tmp files: ${leaked.join(',')}`);
        assert.equal(await fs.promises.readFile(target, 'utf8'), 'third');
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
});

test('writeFileAtomic cleans up the temp file when the rename target is invalid', async () => {
    // Force a rename failure by passing a path whose final component contains
    // an embedded null byte — Node refuses to rename to such a target. The
    // important invariant is that the temp file (which DID get written) is
    // removed before the error bubbles up.
    const dir = await tmpDir();
    try {
        const bad = path.join(dir, 'with\0null.txt');
        await assert.rejects(() => writeFileAtomic(bad, 'data'));
        const entries = await fs.promises.readdir(dir);
        const leaked = entries.filter(e => e.includes('.tmp-'));
        assert.deepEqual(leaked, [], `tmp file leaked after failed rename: ${leaked.join(',')}`);
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
});
