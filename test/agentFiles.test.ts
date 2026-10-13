import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { AddressInfo } from 'net';
import { ApiClient } from '../src/api/client';
import { applyAgentGuidance, splitGuidanceBlock } from '../src/commands/claude';
import {
    GUIDANCE_PLACEHOLDER, decidePull, fromSynced, planAgentPush, pullAgentFiles, pushAgentFiles, sha256, toSynced,
} from '../src/sync/agentFiles';

/**
 * Agent files sync (CLAUDE.md user text + .claude/rules ⇄ the brand).
 *
 * The fake server below follows BrandAgentFilesController: base_hash locking,
 * a stale hash refuses the whole batch with 409 and the server copies,
 * re-sending held content is a no-op. Two project folders play two machines.
 */

const BRAND = 42;

function fakeServer(opts: { missing?: boolean } = {}) {
    const files = new Map<string, { content: string; hash: string }>();
    let puts = 0;
    const list = () => [...files.entries()].sort().map(([p, f]) => ({ path: p, content: f.content, hash: f.hash }));
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const send = (status: number, data: unknown) => {
                res.writeHead(status, { 'content-type': 'application/json' });
                res.end(JSON.stringify(data));
            };
            if (opts.missing || req.url !== `/api/brands/${BRAND}/agent-files`) return send(404, { message: 'Not found' });
            if (req.method === 'GET') return send(200, { files: list() });
            if (req.method !== 'PUT') return send(405, {});
            puts++;
            const writes = (JSON.parse(body) as { files: Array<{ path: string; content: string | null; base_hash: string | null }> }).files;
            const conflicts = [];
            for (const w of writes) {
                const cur = files.get(w.path);
                const serverHash = cur?.hash ?? null;
                const newHash = w.content === null ? null : sha256(w.content);
                if (serverHash === newHash) continue;
                if (serverHash !== w.base_hash) conflicts.push({ path: w.path, hash: serverHash, content: cur?.content ?? null });
            }
            if (conflicts.length) return send(409, { message: 'changed', conflicts });
            for (const w of writes) {
                if (w.content === null) files.delete(w.path);
                else files.set(w.path, { content: w.content, hash: sha256(w.content) });
            }
            send(200, { files: list() });
        });
    });
    return {
        files,
        puts: () => puts,
        async start(): Promise<ApiClient> {
            await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
            const { port } = server.address() as AddressInfo;
            return new ApiClient(`http://127.0.0.1:${port}`, 'test-key');
        },
        stop: () => new Promise<void>((r) => server.close(() => r())),
    };
}

/** A project folder the way `ef init` leaves it: CLAUDE.md holding just the ef block. */
async function machine(): Promise<string> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-agent-'));
    await applyAgentGuidance(path.join(dir, 'CLAUDE.md'));
    return dir;
}

const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');
const write = (dir: string, rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
};
/** Put user text above the ef block, the way a person edits CLAUDE.md. */
const setClaudeText = (dir: string, text: string) => {
    const split = splitGuidanceBlock(read(dir, 'CLAUDE.md'));
    assert.ok(split);
    write(dir, 'CLAUDE.md', `${text}\n\n${split.block}${split.after}`);
};

test('decidePull: whichever side alone changed wins; both changed is a conflict', () => {
    assert.equal(decidePull('a', 'a', null), 'same');
    assert.equal(decidePull(null, null, 'a'), 'same');
    assert.equal(decidePull(null, 's', null), 'write-server');       // new on the brand
    assert.equal(decidePull(null, 'a', 'a'), 'keep-local');          // deleted here, push pending
    assert.equal(decidePull(null, 's', 'a'), 'write-server');        // server edit beats a delete
    assert.equal(decidePull('a', null, 'a'), 'delete-local');        // deleted on the brand
    assert.equal(decidePull('l', null, 'a'), 'keep-local');          // edited here, deleted there
    assert.equal(decidePull('l', null, null), 'keep-local');         // new here
    assert.equal(decidePull('a', 's', 'a'), 'write-server');
    assert.equal(decidePull('l', 'a', 'a'), 'keep-local');
    assert.equal(decidePull('l', 's', 'a'), 'conflict');
    assert.equal(decidePull('l', 's', null), 'conflict');            // no baseline (fresh init)
});

test('CLAUDE.md: the ef block is never synced and comes back as this machine\'s own', async () => {
    const dir = await machine();
    const onlyBlock = read(dir, 'CLAUDE.md');
    assert.equal(toSynced('CLAUDE.md', onlyBlock), null, 'a CLAUDE.md with only the ef block has nothing to sync');

    setClaudeText(dir, '# My rules\n\nUse tabs.');
    const synced = toSynced('CLAUDE.md', read(dir, 'CLAUDE.md')) ?? '';
    assert.ok(synced.startsWith('# My rules\n\nUse tabs.\n\n' + GUIDANCE_PLACEHOLDER));
    assert.ok(!synced.includes('ef:begin'));

    // Another machine's block, with a different CLI version stamp, is kept.
    const other = onlyBlock.replace(/ef:begin v[^\s]+/, 'ef:begin v9.9.9');
    const restored = fromSynced('CLAUDE.md', synced, other, true);
    assert.ok(restored.startsWith('# My rules'));
    assert.ok(restored.includes('ef:begin v9.9.9'));
    assert.ok(!restored.includes(GUIDANCE_PLACEHOLDER));

    // A project that opted out of guidance gets the text without a block.
    assert.equal(fromSynced('CLAUDE.md', synced, '', false).trim(), '# My rules\n\nUse tabs.');
});

test('push from one machine, init on another restores CLAUDE.md text and rules', async () => {
    const srv = fakeServer();
    const api = await srv.start();
    try {
        const a = await machine();
        setClaudeText(a, '# Brand notes\n\nVoice: plain.');
        write(a, '.claude/rules/copy.md', 'No em dashes.\n');
        write(a, '.claude/rules/nested/forms.mdc', 'Label every field.\n');
        write(a, '.claude/rules/notes.txt', 'not a rule');
        const pushed = await pushAgentFiles(api, BRAND, a);
        assert.deepEqual(pushed.pushed.sort(), ['.claude/rules/copy.md', '.claude/rules/nested/forms.mdc', 'CLAUDE.md']);
        assert.deepEqual(pushed.ignored, ['.claude/rules/notes.txt']);
        assert.equal(srv.files.size, 3);

        const b = await machine();
        const pulled = await pullAgentFiles(api, BRAND, b);
        assert.deepEqual(pulled.written.sort(), ['.claude/rules/copy.md', '.claude/rules/nested/forms.mdc', 'CLAUDE.md']);
        assert.equal(read(b, '.claude/rules/copy.md'), 'No em dashes.\n');
        const claude = read(b, 'CLAUDE.md');
        assert.ok(claude.startsWith('# Brand notes\n\nVoice: plain.'));
        assert.equal((claude.match(/ef:begin/g) ?? []).length, 1, 'exactly one ef block');

        // Nothing changed on either side: a second sync is a no-op.
        assert.deepEqual((await planAgentPush(b)).writes, []);
        const again = await pushAgentFiles(api, BRAND, b);
        assert.deepEqual(again.pushed, []);
    } finally { await srv.stop(); }
});

test('init next to differing local files keeps them and lists them', async () => {
    const srv = fakeServer();
    const api = await srv.start();
    try {
        const a = await machine();
        write(a, '.claude/rules/copy.md', 'server version\n');
        await pushAgentFiles(api, BRAND, a);

        const b = await machine();
        write(b, '.claude/rules/copy.md', 'my local version\n');
        const r = await pullAgentFiles(api, BRAND, b);
        assert.deepEqual(r.kept, ['.claude/rules/copy.md']);
        assert.equal(read(b, '.claude/rules/copy.md'), 'my local version\n');

        // --theirs takes the brand's copy and keeps a backup of ours.
        const t = await pullAgentFiles(api, BRAND, b, { theirs: true });
        assert.equal(read(b, '.claude/rules/copy.md'), 'server version\n');
        assert.equal(t.backups.length, 1);
        assert.equal(read(b, t.backups[0]), 'my local version\n');
    } finally { await srv.stop(); }
});

test('both machines edit different lines: the 409 is merged and pushed', async () => {
    const srv = fakeServer();
    const api = await srv.start();
    try {
        const base = 'line 1\nline 2\nline 3\nline 4\nline 5\n';
        const a = await machine();
        write(a, '.claude/rules/r.md', base);
        await pushAgentFiles(api, BRAND, a);
        const b = await machine();
        await pullAgentFiles(api, BRAND, b);

        write(b, '.claude/rules/r.md', base.replace('line 1', 'line 1 (b)'));
        await pushAgentFiles(api, BRAND, b);

        write(a, '.claude/rules/r.md', base.replace('line 5', 'line 5 (a)'));
        const r = await pushAgentFiles(api, BRAND, a);
        assert.deepEqual(r.merged, ['.claude/rules/r.md']);
        assert.deepEqual(r.conflicted, []);
        const want = 'line 1 (b)\nline 2\nline 3\nline 4\nline 5 (a)\n';
        assert.equal(srv.files.get('.claude/rules/r.md')?.content, want);
        assert.equal(read(a, '.claude/rules/r.md'), want);
    } finally { await srv.stop(); }
});

test('both machines edit the same line: markers, not pushed, blocked until resolved', async () => {
    const srv = fakeServer();
    const api = await srv.start();
    try {
        const a = await machine();
        write(a, '.claude/rules/r.md', 'tone: plain\n');
        write(a, '.claude/rules/other.md', 'one\n');
        await pushAgentFiles(api, BRAND, a);
        const b = await machine();
        await pullAgentFiles(api, BRAND, b);

        write(b, '.claude/rules/r.md', 'tone: warm\n');
        await pushAgentFiles(api, BRAND, b);

        write(a, '.claude/rules/r.md', 'tone: formal\n');
        write(a, '.claude/rules/other.md', 'two\n');
        const r = await pushAgentFiles(api, BRAND, a);
        assert.deepEqual(r.conflicted, ['.claude/rules/r.md']);
        assert.match(read(a, '.claude/rules/r.md'), /<<<<<<< local\ntone: formal\n=======\ntone: warm\n>>>>>>> server/);
        assert.equal(srv.files.get('.claude/rules/r.md')?.content, 'tone: warm\n', 'server copy untouched');
        assert.equal(srv.files.get('.claude/rules/other.md')?.content, 'two\n', 'the non-conflicting file still landed');

        const blocked = await pushAgentFiles(api, BRAND, a);
        assert.deepEqual(blocked.blocked, ['.claude/rules/r.md']);

        write(a, '.claude/rules/r.md', 'tone: formal and warm\n');
        const resolved = await pushAgentFiles(api, BRAND, a);
        assert.deepEqual(resolved.pushed, ['.claude/rules/r.md']);
        assert.equal(srv.files.get('.claude/rules/r.md')?.content, 'tone: formal and warm\n');
    } finally { await srv.stop(); }
});

test('deletes: propagate when untouched, lose to an edit on the other side', async () => {
    const srv = fakeServer();
    const api = await srv.start();
    try {
        const a = await machine();
        write(a, '.claude/rules/x.md', 'x\n');
        write(a, '.claude/rules/y.md', 'y\n');
        setClaudeText(a, 'mine');
        await pushAgentFiles(api, BRAND, a);
        const b = await machine();
        await pullAgentFiles(api, BRAND, b);

        // a deletes x and its CLAUDE.md text; b edits y; a deletes y too.
        fs.rmSync(path.join(a, '.claude/rules/x.md'));
        write(a, 'CLAUDE.md', splitGuidanceBlock(read(a, 'CLAUDE.md'))!.block + '\n');
        write(b, '.claude/rules/y.md', 'y edited\n');
        await pushAgentFiles(api, BRAND, b);
        fs.rmSync(path.join(a, '.claude/rules/y.md'));

        const r = await pushAgentFiles(api, BRAND, a);
        assert.deepEqual(r.restored, ['.claude/rules/y.md']);
        assert.equal(read(a, '.claude/rules/y.md'), 'y edited\n');
        assert.deepEqual(r.deleted.sort(), ['.claude/rules/x.md', 'CLAUDE.md']);
        assert.ok(!srv.files.has('.claude/rules/x.md'));

        // b follows the deletes and keeps its ef block.
        const p = await pullAgentFiles(api, BRAND, b);
        assert.deepEqual(p.deleted.sort(), ['.claude/rules/x.md', 'CLAUDE.md']);
        assert.ok(!fs.existsSync(path.join(b, '.claude/rules/x.md')));
        assert.ok(read(b, 'CLAUDE.md').startsWith('<!-- ef:begin'));
    } finally { await srv.stop(); }
});

test('a server without the endpoint is reported as unsupported, nothing written', async () => {
    const srv = fakeServer({ missing: true });
    const api = await srv.start();
    try {
        const a = await machine();
        write(a, '.claude/rules/r.md', 'r\n');
        assert.equal((await pullAgentFiles(api, BRAND, a)).unsupported, true);
        assert.equal((await pushAgentFiles(api, BRAND, a)).unsupported, true);
        assert.ok(!fs.existsSync(path.join(a, '.ef', 'agent-files.json')));
    } finally { await srv.stop(); }
});
