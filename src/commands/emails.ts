import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { BrandEmail } from '../api/types';
import { CliError, ExitCode } from '../utils/exit';
import { c, log } from '../utils/log';
import { loadRuntime, EfRuntime } from '../utils/store';
import { fileExists, sha256, writeFileAtomic } from '../utils/fs';
import { formatRelative, renderTable } from '../utils/format';
import {
    EmailMeta,
    metaFromEmail,
    metaToPayload,
    parseEmailFile,
    relPathForEmail,
    sanitizeCode,
    serializeEmailFile,
} from '../sync/emailFile';

interface CreateOpts {
    name?: string; subject?: string; previewText?: string; fromName?: string;
    fromEmail?: string; replyTo?: string; variableScope?: string; file?: string;
    json?: boolean;
}

type EmailStatus = 'clean' | 'dirty' | 'server-newer' | 'both-changed' | 'local-only' | 'differs';

function bodyHash(body: string): string {
    return sha256(Buffer.from(body, 'utf8'));
}

/** Drift status of a local file vs. the server, using the front-matter baseline. */
function computeStatus(meta: EmailMeta, localBody: string, server: BrandEmail | null): EmailStatus {
    if (!server) return 'local-only';
    const localHash = bodyHash(localBody);
    const serverHash = bodyHash(server.html ?? '');
    if (meta.baseHash == null) {
        // No baseline recorded (file predates the guard) — fall back to content compare.
        return serverHash === localHash ? 'clean' : 'differs';
    }
    const localDirty = localHash !== meta.baseHash;
    const su = server.updated_at ? Date.parse(server.updated_at) : NaN;
    const ru = meta.remoteUpdatedAt ? Date.parse(meta.remoteUpdatedAt) : NaN;
    const serverNewer = Number.isFinite(su) && Number.isFinite(ru) && su > ru;
    if (localDirty && serverNewer) return 'both-changed';
    if (localDirty) return 'dirty';
    if (serverNewer) return 'server-newer';
    return 'clean';
}

/** Save a copy of `content` under .ef-history/emails/ before we clobber it. */
async function snapshotEmailHistory(rt: EfRuntime, code: string, content: string): Promise<void> {
    const dir = path.join(rt.brandRoot, '.ef-history', 'emails');
    await fs.promises.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safe = sanitizeCode(code);
    await writeFileAtomic(path.join(dir, `${safe}-${stamp}.html`), content);
    // Keep the newest N snapshots per code.
    const keep = rt.config.historyKeep ?? 20;
    try {
        const files = (await fs.promises.readdir(dir)).filter((f) => f.startsWith(`${safe}-`)).sort();
        for (let i = 0; i < files.length - keep; i++) {
            await fs.promises.unlink(path.join(dir, files[i])).catch(() => { /* best-effort */ });
        }
    } catch { /* best-effort */ }
}

/** Write `emails/<code>.html`, stamping the drift baseline (updated_at + body hash). */
async function writeEmailToDisk(rt: EfRuntime, meta: EmailMeta, body: string, id: number, code: string | null, remoteUpdatedAt?: string): Promise<string> {
    const rel = relPathForEmail({ code, id });
    const abs = path.join(rt.brandRoot, rel);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    const stamped: EmailMeta = { ...meta, v: 1, id, code: code ?? undefined, baseHash: bodyHash(body) };
    if (remoteUpdatedAt) stamped.remoteUpdatedAt = remoteUpdatedAt;
    await writeFileAtomic(abs, serializeEmailFile(stamped, body));
    return rel;
}

/** Resolve the email files to push/diff: explicit paths/codes, or every emails/*.html. */
async function collectEmailFiles(rt: EfRuntime, paths: string[]): Promise<string[]> {
    const emailsDir = path.join(rt.brandRoot, 'emails');
    if (!paths || paths.length === 0) {
        let entries: string[] = [];
        try { entries = await fs.promises.readdir(emailsDir); } catch { return []; }
        return entries.filter((f) => f.toLowerCase().endsWith('.html')).sort().map((f) => path.join(emailsDir, f));
    }
    const out: string[] = [];
    for (const p of paths) {
        const direct = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
        if (await fileExists(direct)) { out.push(direct); continue; }
        const code = sanitizeCode(p.replace(/^emails\//, '').replace(/\.html$/i, ''));
        const abs = path.join(emailsDir, `${code}.html`);
        if (await fileExists(abs)) { out.push(abs); continue; }
        throw new CliError(ExitCode.NotFound, `No email file for "${p}" (looked for ${abs}). Pull it first or pass a real path.`);
    }
    return out;
}

function relOf(rt: EfRuntime, abs: string): string {
    return abs.startsWith(rt.brandRoot + path.sep) ? abs.slice(rt.brandRoot.length + 1).split(path.sep).join('/') : path.basename(abs);
}

export function registerEmailsCommand(program: Command): void {
    const cmd = program
        .command('emails')
        .description('Email template actions: list, get, pull, push, diff, create, delete (emails/<code>.html).');

    cmd.command('list')
        .alias('ls')
        .description('List the brand\'s email templates.')
        .option('--json', 'Print rows as JSON.')
        .action(async (opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const rows = await api.listEmails(rt.config.brandId);
            if (opts.json) { log.json(rows); return; }
            log.raw(renderTable({
                head: ['#', 'code', 'name', 'subject', 'updated'],
                rows: rows.map((e) => [String(e.id), e.code ?? '', e.name ?? '', e.subject ?? '', formatRelative(e.updated_at)]),
            }) + '\n');
            log.detail(`${rows.length} emails`);
        });

    cmd.command('get <idOrCode>')
        .description('Print one email — the HTML body, or the full record with --json.')
        .option('--json', 'Print the full email record as JSON.')
        .action(async (idOrCode: string, opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const email = await api.getEmail(rt.config.brandId, idOrCode);
            if (opts.json) { log.json(email); return; }
            process.stdout.write((email.html ?? '') + '\n');
        });

    cmd.command('pull [idOrCode]')
        .description('Pull one email (by id/code) or every email to emails/<code>.html. Keeps locally-edited files unless --force.')
        .option('--force', 'Overwrite locally-edited files with the server version (a copy is saved to .ef-history).')
        .option('--json', 'Print result as JSON.')
        .action(async (idOrCode: string | undefined, opts: { force?: boolean; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const targets: BrandEmail[] = idOrCode
                ? [await api.getEmail(rt.config.brandId, idOrCode)]
                : await api.listEmails(rt.config.brandId);

            const pulled: string[] = [];
            const kept: string[] = [];
            for (const summary of targets) {
                const email = idOrCode ? summary : await api.getEmail(rt.config.brandId, summary.id);
                const rel = relPathForEmail({ code: email.code ?? null, id: email.id });
                const abs = path.join(rt.brandRoot, rel);

                if (await fileExists(abs)) {
                    const { meta, body } = parseEmailFile(await fs.promises.readFile(abs, 'utf8'));
                    const localEdited = meta.baseHash != null && bodyHash(body) !== meta.baseHash;
                    if (localEdited && !opts.force) { kept.push(rel); continue; }
                    if (opts.force) await snapshotEmailHistory(rt, email.code ?? String(email.id), await fs.promises.readFile(abs, 'utf8'));
                }
                await writeEmailToDisk(rt, metaFromEmail(email), email.html ?? '', email.id, email.code ?? null, email.updated_at);
                pulled.push(rel);
            }
            if (opts.json) { log.json({ ok: true, pulled, kept }); return; }
            for (const rel of pulled) log.info(`  ${c.green('pulled')} ${rel}`);
            for (const rel of kept) log.warn(`kept ${rel} — edited locally since last sync (use --force to overwrite).`);
            log.success(`Pulled ${pulled.length} email${pulled.length === 1 ? '' : 's'}${kept.length ? `, kept ${kept.length} local edit${kept.length === 1 ? '' : 's'}` : ''}.`);
        });

    cmd.command('create <code>')
        .description('Create an email template. Metadata via flags; HTML body via --file (optional), then written to disk.')
        .option('--name <name>', 'Display name (defaults to the code).')
        .option('--subject <text>', 'Subject line.')
        .option('--preview-text <text>', 'Inbox preview snippet.')
        .option('--from-name <name>', 'From name.')
        .option('--from-email <email>', 'From email address.')
        .option('--reply-to <email>', 'Reply-to email address.')
        .option('--variable-scope <scope>', 'Template variable scope (e.g. purchase, refund).')
        .option('--file <path>', 'HTML file to use as the email body ("-" reads stdin).')
        .option('--json', 'Print result as JSON.')
        .action(async (code: string, opts: CreateOpts) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const meta: EmailMeta = {
                v: 1, code,
                name: opts.name ?? code,
                subject: opts.subject,
                preview_text: opts.previewText,
                from_name: opts.fromName,
                from_email: opts.fromEmail,
                reply_to_email: opts.replyTo,
                variable_scope: opts.variableScope,
            };
            let body = '';
            if (opts.file) {
                body = opts.file === '-' ? await readStdin() : await fs.promises.readFile(path.resolve(opts.file), 'utf8');
            }
            const created = await api.createEmail(rt.config.brandId, metaToPayload(meta, code));
            if (body.trim() !== '') await api.saveEmailBody(rt.config.brandId, created.id, { html: body });
            const fresh = await api.getEmail(rt.config.brandId, created.id).catch(() => created);
            const rel = await writeEmailToDisk(rt, meta, body, created.id, created.code ?? code, fresh.updated_at);
            if (opts.json) { log.json({ ok: true, email: created, file: rel }); return; }
            log.success(`Created email #${created.id} (${created.code ?? code}). Wrote ${rel}.`);
        });

    cmd.command('push [paths...]')
        .description('Push email files (upsert by id/code). Refuses if the email changed on the server since you pulled (--force to override).')
        .option('--force', 'Push even if the server changed since you pulled (its server version is snapshotted to .ef-history first).')
        .option('--json', 'Print results as JSON.')
        .action(async (paths: string[], opts: { force?: boolean; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const files = await collectEmailFiles(rt, paths);
            if (files.length === 0) {
                if (opts.json) { log.json({ ok: true, pushed: [], conflicts: [] }); return; }
                log.warn('No email files found under emails/. Nothing to push.');
                return;
            }
            const results: { rel: string; id: number; action: 'created' | 'updated' }[] = [];
            const conflicts: { rel: string; status: EmailStatus }[] = [];

            for (const abs of files) {
                const { meta, body } = parseEmailFile(await fs.promises.readFile(abs, 'utf8'));
                const fallbackCode = sanitizeCode(path.basename(abs, path.extname(abs)));
                const payload = metaToPayload(meta, fallbackCode);
                const identity = meta.id ?? (payload.code as string);
                const rel = relOf(rt, abs);

                let existing: BrandEmail | null = null;
                try { existing = await api.getEmail(rt.config.brandId, identity); } catch (err) {
                    if (!(err instanceof CliError && err.code === ExitCode.NotFound)) throw err;
                }

                if (existing && !opts.force) {
                    const status = computeStatus(meta, body, existing);
                    if (status === 'server-newer' || status === 'both-changed') { conflicts.push({ rel, status }); continue; }
                }
                if (existing && opts.force) {
                    await snapshotEmailHistory(rt, existing.code ?? String(existing.id), serializeEmailFile(metaFromEmail(existing), existing.html ?? ''));
                }

                let id: number;
                let action: 'created' | 'updated';
                if (existing) {
                    await api.updateEmail(rt.config.brandId, existing.id, payload);
                    await api.saveEmailBody(rt.config.brandId, existing.id, { html: body, css: existing.css ?? '', config: existing.config });
                    id = existing.id;
                    action = 'updated';
                } else {
                    const created = await api.createEmail(rt.config.brandId, payload);
                    await api.saveEmailBody(rt.config.brandId, created.id, { html: body });
                    id = created.id;
                    action = 'created';
                }

                // Re-stamp the baseline from the server's post-write state.
                const fresh = await api.getEmail(rt.config.brandId, id).catch(() => null);
                await writeFileAtomic(abs, serializeEmailFile({ ...meta, v: 1, id, code: payload.code as string, remoteUpdatedAt: fresh?.updated_at, baseHash: bodyHash(body) }, body));
                results.push({ rel, id, action });
            }

            if (opts.json) {
                log.json({ ok: conflicts.length === 0, pushed: results, conflicts });
            } else {
                for (const r of results) log.info(`  ${c.green(r.action)} ${r.rel} (id ${r.id})`);
                for (const cf of conflicts) log.error(`  ${cf.rel}: ${cf.status} — changed on the server since you pulled. Pull it, or push --force to overwrite.`);
                if (results.length) log.success(`Pushed ${results.length} email${results.length === 1 ? '' : 's'}.`);
            }
            if (conflicts.length) process.exitCode = ExitCode.Conflict;
        });

    cmd.command('diff [idOrCode]')
        .description('Show drift between local email files and the server (clean / dirty / server-newer / both-changed).')
        .option('--json', 'Print entries as JSON.')
        .action(async (idOrCode: string | undefined, opts: { json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const files = await collectEmailFiles(rt, idOrCode ? [idOrCode] : []);
            const entries: { rel: string; id: number | null; status: EmailStatus }[] = [];
            for (const abs of files) {
                const { meta, body } = parseEmailFile(await fs.promises.readFile(abs, 'utf8'));
                const identity = meta.id ?? sanitizeCode(path.basename(abs, path.extname(abs)));
                let server: BrandEmail | null = null;
                try { server = await api.getEmail(rt.config.brandId, identity); } catch (err) {
                    if (!(err instanceof CliError && err.code === ExitCode.NotFound)) throw err;
                }
                entries.push({ rel: relOf(rt, abs), id: meta.id ?? server?.id ?? null, status: computeStatus(meta, body, server) });
            }
            if (opts.json) { log.json(entries); return; }
            if (entries.length === 0) { log.detail('No local email files under emails/.'); return; }
            log.raw(renderTable({
                head: ['status', 'id', 'file'],
                rows: entries.map((e) => [e.status, e.id != null ? String(e.id) : '', e.rel]),
            }) + '\n');
            const drifted = entries.filter((e) => e.status !== 'clean').length;
            log.detail(`${entries.length} file(s), ${drifted} with drift`);
        });

    cmd.command('delete <idOrCode>')
        .description('Delete an email template (and its local file).')
        .option('--force', 'Do not require confirmation in interactive runs.')
        .option('--json', 'Print result as JSON.')
        .action(async (idOrCode: string, opts: { force?: boolean; json?: boolean }) => {
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const email = await api.getEmail(rt.config.brandId, idOrCode);
            if (!opts.force && process.stdin.isTTY) {
                const { confirm } = await import('../utils/prompt');
                const ok = await confirm(`Delete email "${email.code ?? email.id}" (#${email.id})?`, false);
                if (!ok) throw new CliError(ExitCode.Validation, 'Aborted.');
            }
            await api.deleteEmail(rt.config.brandId, email.id);
            const rel = relPathForEmail(email);
            let fileRemoved = false;
            try { await fs.promises.unlink(path.join(rt.brandRoot, rel)); fileRemoved = true; } catch { /* no local file */ }
            if (opts.json) { log.json({ ok: true, deleted: { id: email.id, code: email.code }, localFileRemoved: fileRemoved }); return; }
            log.success(`Deleted email #${email.id}.${fileRemoved ? ` Removed ${rel}.` : ''}`);
        });
}

function readStdin(): Promise<string> {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (d) => (data += d));
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', reject);
    });
}
