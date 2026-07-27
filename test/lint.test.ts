import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'ef.js');

interface JsonReport { file: string; kind: string; ok: boolean; issues: { line?: number; severity: string; message: string }[]; }

async function setupProject(): Promise<{ root: string; brandRoot: string }> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ef-cli-lint-'));
    await fs.promises.mkdir(path.join(root, '.ef'), { recursive: true });
    await fs.promises.writeFile(
        path.join(root, '.ef', 'config.json'),
        JSON.stringify({ apiUrl: 'https://app.example', brandId: 7, syncRoot: 'elasticfunnels', syncLayout: 'flat', saveMode: 'direct' }),
    );
    await fs.promises.writeFile(path.join(root, '.ef', 'auth'), 'k\n');
    const brandRoot = path.join(root, 'elasticfunnels');
    for (const d of ['pages', 'components', 'scripts']) await fs.promises.mkdir(path.join(brandRoot, d), { recursive: true });

    // Valid page.
    await fs.promises.writeFile(path.join(brandRoot, 'pages', 'good.ef'),
        '{{-- efmeta:{"v":1,"type":"page","id":10,"slug":"good"} --}}\n<h1>Hi</h1>\n@if(user.active)\n<p>yo</p>\n@endif\n');
    // Broken page: unclosed {{, unclosed @if + @foreach, unknown @directive.
    await fs.promises.writeFile(path.join(brandRoot, 'pages', 'bad.ef'),
        '{{-- efmeta:{"v":1,"type":"page","id":11,"slug":"bad"} --}}\n@if(x)\n  {{ name\n@foreach(items)\n<p>@bogus(y)</p>\n');
    // Warning-only page: unknown filter.
    await fs.promises.writeFile(path.join(brandRoot, 'pages', 'warnonly.ef'),
        '{{-- efmeta:{"v":1,"type":"page","id":40,"slug":"warnonly"} --}}\n<p>{{ name | bogusfilter }}</p>\n');
    // Component with a duplicated efmeta line (identity theft).
    await fs.promises.writeFile(path.join(brandRoot, 'components', 'dup.ef'),
        '{{-- efmeta:{"v":1,"type":"component","id":30,"code":"dup"} --}}\n<div>ok</div>\n{{-- efmeta:{"v":1,"type":"component","id":99,"code":"other"} --}}\n');
    // Valid backend script.
    await fs.promises.writeFile(path.join(brandRoot, 'scripts', 'ok.js'),
        '// efmeta:{"v":1,"type":"script","id":20,"code":"ok"}\nexport function run() {\n  return setVariable("x", 1);\n}\n');
    // Broken backend script: JS syntax error.
    await fs.promises.writeFile(path.join(brandRoot, 'scripts', 'broken.js'),
        '// efmeta:{"v":1,"type":"script","id":21,"code":"broken"}\nconst x = ;\n');
    return { root, brandRoot };
}

function runEf(cwd: string, args: string[]): { stdout: string; stderr: string; status: number | null } {
    const r = spawnSync(process.execPath, [BIN_PATH, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

test('lint: full run exits 2 and flags the broken files, passes the good ones', async () => {
    const { root } = await setupProject();
    try {
        const res = runEf(root, ['lint', '--json']);
        assert.equal(res.status, 2, `expected non-zero from errors; stderr=${res.stderr}`);
        const reports = JSON.parse(res.stdout) as JsonReport[];
        const by = (f: string) => reports.find((r) => r.file === f);

        assert.equal(by('pages/good.ef')!.ok, true, 'good.ef clean');
        assert.equal(by('scripts/ok.js')!.ok, true, 'ok.js clean');

        assert.equal(by('pages/bad.ef')!.ok, false, 'bad.ef has errors');
        assert.ok(by('pages/bad.ef')!.issues.some((i) => /Unclosed \{\{/.test(i.message)), 'unclosed interpolation');
        assert.ok(by('pages/bad.ef')!.issues.some((i) => /Unknown directive @bogus/.test(i.message)), 'unknown directive');

        assert.equal(by('scripts/broken.js')!.ok, false, 'broken.js fails to parse');
        assert.ok(by('scripts/broken.js')!.issues.some((i) => /does not parse/.test(i.message)));

        assert.equal(by('components/dup.ef')!.ok, false, 'dup.ef duplicated efmeta');
        assert.ok(by('components/dup.ef')!.issues.some((i) => /Duplicated efmeta/.test(i.message)));

        // warnonly.ef: warning present but no errors → still ok.
        assert.equal(by('pages/warnonly.ef')!.ok, true);
        assert.ok(by('pages/warnonly.ef')!.issues.some((i) => i.severity === 'warning' && /bogusfilter/.test(i.message)));
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('lint: a single clean file exits 0', async () => {
    const { root } = await setupProject();
    try {
        const res = runEf(root, ['lint', 'pages/good.ef']);
        assert.equal(res.status, 0, `stderr=${res.stderr}`);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('lint: warnings pass by default but fail under --strict', async () => {
    const { root } = await setupProject();
    try {
        assert.equal(runEf(root, ['lint', 'pages/warnonly.ef']).status, 0, 'warning alone passes');
        assert.equal(runEf(root, ['lint', 'pages/warnonly.ef', '--strict']).status, 2, '--strict fails on warnings');
        // --quiet hides the warning from JSON output.
        const quiet = JSON.parse(runEf(root, ['lint', 'pages/warnonly.ef', '--quiet', '--json']).stdout) as JsonReport[];
        assert.equal(quiet[0].issues.length, 0, 'quiet drops warnings');
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});
