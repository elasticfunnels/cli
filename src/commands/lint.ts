import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { c, log } from '../utils/log';
import { CliError, ExitCode } from '../utils/exit';
import { loadRuntime } from '../utils/store';
import { classifyAbsPath } from '../sync/sync';
import { resolveSyncPathInput } from '../utils/syncPathResolve';
import { lintEfContent, LintIssue } from '../lint/lintEf';
import { structuralLintGraph } from '../sync/graph';

interface LintOpts { json?: boolean; quiet?: boolean; strict?: boolean; }

interface FileReport {
    file: string;
    kind: 'page' | 'component' | 'script' | 'events' | 'funnel';
    ok: boolean;
    issues: LintIssue[];
}

/** Walk a directory collecting lintable-looking files (same skip rules as sync). */
async function walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    const recurse = async (d: string): Promise<void> => {
        let entries: fs.Dirent[] = [];
        try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.name.startsWith('.')) continue;
            if (e.name === 'node_modules') continue;
            if (e.name.endsWith('~') || e.name.endsWith('.swp') || e.name.endsWith('.swo')) continue;
            if (/\.tmp-\d+-\d+(?:-[a-z0-9]+)?$/.test(e.name)) continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) await recurse(p);
            else if (e.isFile()) out.push(p);
        }
    };
    await recurse(dir);
    return out;
}

/** Offline lint of a Drawflow graph file: valid JSON + structural shape. */
function lintGraphContent(content: string): LintIssue[] {
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch (err) {
        return [{ severity: 'error', message: `Invalid JSON: ${(err as Error).message.split('\n')[0]}` }];
    }
    return structuralLintGraph(parsed).map((g) => ({ severity: g.severity, message: g.message }));
}

export function registerLintCommand(program: Command): void {
    program
        .command('lint [paths...]')
        .description('Statically validate .ef pages/components and backend scripts (no server needed).')
        .addHelpText('after', `
Checks each file's template + script syntax WITHOUT executing it: unclosed {{ }}/[[ ]],
unknown @directives and filters, unbalanced @if/@foreach/<template-*>, engine bleed
(mixing {{ }} and [[ ]]), duplicated efmeta identity lines, and backend-script JS parse
errors / illegal imports. Exits non-zero (2) if any errors are found.

Examples:
  ef lint                       # lint every page/component/script under the brand root
  ef lint pages/                # only the pages folder
  ef lint pages/about-us.ef     # one file
  ef lint about-us              # page slug shorthand
  ef lint --strict              # treat warnings as failures too
  ef lint --json | jq '.[] | select(.ok == false)'`)
        .option('--json', 'Print one report object per linted file as JSON.')
        .option('--quiet', 'Only report errors (hide warnings).')
        .option('--strict', 'Treat warnings as failures (non-zero exit).')
        .action(async (paths: string[], opts: LintOpts) => {
            const rt = await loadRuntime();
            const brandRoot = rt.brandRoot;
            const explicit = Array.isArray(paths) && paths.length > 0;

            // Collect target files.
            let targets: string[] = [];
            if (explicit) {
                for (const p of paths) {
                    let abs: string;
                    try {
                        abs = await resolveSyncPathInput(brandRoot, p, rt.config.syncRoot);
                    } catch {
                        throw new CliError(ExitCode.NotFound, `Cannot resolve "${p}" under the brand root.`);
                    }
                    let stat: fs.Stats;
                    try { stat = await fs.promises.stat(abs); } catch { throw new CliError(ExitCode.NotFound, `Path not found: ${p}`); }
                    if (stat.isDirectory()) targets.push(...(await walk(abs)));
                    else targets.push(abs);
                }
            } else {
                targets = await walk(brandRoot);
            }
            targets = Array.from(new Set(targets)).sort();

            const exists = (sub: string): boolean => fs.existsSync(path.join(brandRoot, sub));
            const reports: FileReport[] = [];
            const skipped: string[] = [];

            for (const abs of targets) {
                // Drawflow graph files (events/funnels): offline STRUCTURAL lint only
                // (valid JSON + drawflow shape). Deep node-rule validation is
                // server-side — "ef pages events validate".
                if (abs.endsWith('.events.json') || abs.endsWith('.flow.json')) {
                    const rel = path.relative(brandRoot, abs).split(path.sep).join('/');
                    let content: string;
                    try { content = await fs.promises.readFile(abs, 'utf8'); } catch { continue; }
                    const gIssues = lintGraphContent(content);
                    const kind: FileReport['kind'] = abs.endsWith('.flow.json') ? 'funnel' : 'events';
                    reports.push({ file: rel, kind, ok: !gIssues.some((i) => i.severity === 'error'), issues: opts.quiet ? gIssues.filter((i) => i.severity === 'error') : gIssues });
                    continue;
                }
                const cls = classifyAbsPath(brandRoot, abs);
                if (!cls || cls.kind === 'asset') {
                    if (explicit) skipped.push(path.relative(brandRoot, abs) || abs);
                    continue;
                }
                const kind = cls.kind; // 'page' | 'component' | 'script'
                let content: string;
                try { content = await fs.promises.readFile(abs, 'utf8'); } catch { continue; }
                const res = lintEfContent(content, {
                    filePath: cls.rel,
                    kind,
                    componentExists: (code) => exists(`components/${code}.ef`),
                    pageExists: (slug) => exists(`pages/${slug}.ef`),
                    scriptExists: (code) => exists(`scripts/${code}.js`),
                });
                const issues = opts.quiet ? res.issues.filter((i) => i.severity === 'error') : res.issues;
                reports.push({ file: cls.rel, kind, ok: res.ok, issues });
            }

            const errorCount = reports.reduce((n, r) => n + r.issues.filter((i) => i.severity === 'error').length, 0);
            const warnCount = reports.reduce((n, r) => n + r.issues.filter((i) => i.severity === 'warning').length, 0);

            if (opts.json) {
                log.json(reports);
            } else {
                for (const s of skipped) log.detail(`  (skipped ${s} — not a lintable file; expected pages/*.ef, components/*.ef, or scripts/*.js)`);
                for (const r of reports) {
                    if (r.issues.length === 0) continue;
                    log.info(`\n${c.bold(r.file)}`);
                    for (const i of r.issues) {
                        const tag = i.severity === 'error' ? c.red('error') : c.yellow('warn ');
                        const loc = i.line != null ? c.dim(`line ${i.line}`) : c.dim('     ');
                        log.info(`  ${tag} ${loc}  ${i.message}`);
                    }
                }
                log.info('');
                if (errorCount === 0 && warnCount === 0) {
                    log.success(`Linted ${reports.length} file(s) — no issues.`);
                } else {
                    const parts: string[] = [];
                    if (errorCount) parts.push(c.red(`${errorCount} error${errorCount === 1 ? '' : 's'}`));
                    if (warnCount) parts.push(c.yellow(`${warnCount} warning${warnCount === 1 ? '' : 's'}`));
                    const filesWithIssues = reports.filter((r) => r.issues.length > 0).length;
                    log.info(`${parts.join(', ')} in ${filesWithIssues} of ${reports.length} file(s).`);
                }
            }

            const fail = errorCount > 0 || (Boolean(opts.strict) && warnCount > 0);
            if (fail) process.exitCode = ExitCode.Validation;
        });
}
