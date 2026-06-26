#!/usr/bin/env node
// Package the grammar-only VS Code extension under extensions/ef-syntax/ into a
// .vsix and drop it in assets/, where `ef install-highlighter` looks for it and
// from where it's bundled into the npm tarball (see package.json "files").
//
// Uses @vscode/vsce via npx so it doesn't have to be a hard dependency.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extDir = join(root, 'extensions', 'ef-syntax');
const assetsDir = join(root, 'assets');

const { name, version } = JSON.parse(readFileSync(join(extDir, 'package.json'), 'utf8'));
const outFile = join(assetsDir, `${name}-${version}.vsix`);

mkdirSync(assetsDir, { recursive: true });

// Clear any stale vsix so the runtime "highest version" pick stays clean.
for (const f of readdirSync(assetsDir)) {
    if (/^ef-syntax-.*\.vsix$/.test(f)) rmSync(join(assetsDir, f));
}

console.log(`Packaging ${name}@${version} → ${outFile}`);
const r = spawnSync(
    'npx',
    ['--yes', '@vscode/vsce@latest', 'package', '--no-dependencies', '--allow-missing-repository', '-o', outFile],
    { cwd: extDir, stdio: 'inherit' },
);

if (r.error) {
    console.error('Failed to run vsce:', r.error.message);
    process.exit(1);
}
process.exit(r.status ?? 1);
