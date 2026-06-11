import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/** SHA-256 hash of a Buffer or Uint8Array, as lowercase hex. */
export function sha256(bytes: Buffer | Uint8Array): string {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

export async function readFileBytes(p: string): Promise<Buffer> {
    return await fs.promises.readFile(p);
}

export async function readFileText(p: string): Promise<string> {
    return (await fs.promises.readFile(p, 'utf8'));
}

export async function writeFileBytes(p: string, bytes: Buffer | Uint8Array): Promise<void> {
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, bytes);
}

export async function writeFileText(p: string, text: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, text, 'utf8');
}

/** Atomic write: write to a sibling temp file then rename. Avoids partial
 *  writes when the process is killed mid-save. If anything fails between
 *  `writeFile` and `rename` we clean up the temp file so we never leak
 *  `.tmp-…` artefacts in the user's project. */
export async function writeFileAtomic(p: string, bytes: Buffer | Uint8Array | string): Promise<void> {
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let wrote = false;
    try {
        if (typeof bytes === 'string') {
            await fs.promises.writeFile(tmp, bytes, 'utf8');
        } else {
            await fs.promises.writeFile(tmp, bytes);
        }
        wrote = true;
        await fs.promises.rename(tmp, p);
    } catch (err) {
        if (wrote) {
            try { await fs.promises.unlink(tmp); } catch { /* tolerated */ }
        }
        throw err;
    }
}

export async function fileExists(p: string): Promise<boolean> {
    try { await fs.promises.stat(p); return true; } catch { return false; }
}

export async function ensureDir(p: string): Promise<void> {
    await fs.promises.mkdir(p, { recursive: true });
}

/** Add a single line to a `.gitignore` at the given path if it isn't
 *  already present. Creates the file if missing. Used during `ef init`
 *  to make sure `.ef/` never gets accidentally committed. */
export async function ensureGitignoreEntry(gitignorePath: string, entry: string): Promise<void> {
    let body = '';
    try {
        body = await fs.promises.readFile(gitignorePath, 'utf8');
    } catch {
        body = '';
    }
    const lines = body.split('\n').map(l => l.trim());
    if (lines.includes(entry) || lines.includes(`${entry}/`)) return;
    const append = (body.length > 0 && !body.endsWith('\n')) ? `\n${entry}\n` : `${entry}\n`;
    await fs.promises.appendFile(gitignorePath, append);
}

/** Walk up from `start` looking for a directory that contains `marker`.
 *  Returns the directory path or `null`. Used to find both the project
 *  root (`.ef`) and the workspace root (`.git`). */
export function findUp(start: string, marker: string): string | null {
    let cur = path.resolve(start);
    // Stop at filesystem root (when dirname returns the same path).
    for (;;) {
        if (fs.existsSync(path.join(cur, marker))) return cur;
        const parent = path.dirname(cur);
        if (parent === cur) return null;
        cur = parent;
    }
}

/** Like findUp() but returns the actual marker path. */
export function findUpFile(start: string, marker: string): string | null {
    const dir = findUp(start, marker);
    return dir ? path.join(dir, marker) : null;
}
