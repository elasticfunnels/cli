import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { SplitTestNodeCode } from '../api/types';
import { CliError, ExitCode } from '../utils/exit';
import { c, log } from '../utils/log';
import { loadRuntime } from '../utils/store';
import { renderTable } from '../utils/format';

/**
 * `ef splits` — act on a split test. Reading its numbers stays in `ef stats
 * split`, which has no write path by design; everything here changes what
 * visitors are served.
 *
 * A winner is declared by node_code, because that is what the runtime buckets
 * visitors by. Names are accepted for convenience and resolved against the
 * test's own node-codes list, so a typo cannot finalize a test on a code that
 * is not one of its arms — the server does not check that for us.
 */

/** Match a variant by node_code first, then by name (case-insensitive). */
function resolveVariant(arms: SplitTestNodeCode[], wanted: string): SplitTestNodeCode {
    const exact = arms.find(a => a.code === wanted);
    if (exact) return exact;
    const lower = wanted.trim().toLowerCase();
    const byName = arms.filter(a => a.name.trim().toLowerCase() === lower);
    if (byName.length === 1) return byName[0];
    const listed = arms.map(a => `  ${a.name}  ${c.dim(a.code)}`).join('\n');
    if (byName.length > 1) {
        throw new CliError(ExitCode.Validation, `More than one variant is named "${wanted}" — pass its node code instead:\n${listed}`);
    }
    throw new CliError(ExitCode.Validation, `No variant "${wanted}" on this test. Its variants are:\n${listed || '  (none — the graph has no node codes; see the ef-page-events skill)'}`);
}

export function registerSplitsCommand(program: Command): void {
    const cmd = program
        .command('splits')
        .description('Act on a split test: list its variants, declare a winner. (Results: ef stats split <id>.)');

    // ── ef splits variants <id> ──────────────────────────────────────
    cmd.command('variants <id>')
        .description('List a split test\'s variants with the node codes a winner is declared by.')
        .option('--json', 'Print as JSON.')
        .action(async (id: string, opts: { json?: boolean }) => {
            const splitTestId = Number(id);
            if (!Number.isInteger(splitTestId) || splitTestId <= 0) throw new CliError(ExitCode.Validation, 'Pass a numeric split test id.');
            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const [test, arms] = await Promise.all([
                api.getSplitTest(rt.config.brandId, splitTestId),
                api.getSplitTestNodeCodes(rt.config.brandId, splitTestId),
            ]);

            if (opts.json) { log.json({ ok: true, split_test: { id: test.id, name: test.name, status: test.status }, variants: arms }); return; }
            log.info(`${c.bold(test.name ?? `Split test ${splitTestId}`)} ${c.dim(`(#${splitTestId}, ${test.status ?? 'unknown status'})`)}`);
            if (arms.length === 0) {
                log.info('No variants with node codes — the graph has not minted them yet (see the ef-page-events skill).');
                return;
            }
            process.stdout.write(renderTable({ head: ['VARIANT', 'NODE CODE'], rows: arms.map(a => [a.name, a.code]) }) + '\n');
        });

    // ── ef splits winner <id> <variant> ──────────────────────────────
    cmd.command('winner <id> <variant>')
        .description('Declare a winner: finalize the test and send all its traffic to one variant.')
        .option('-y, --yes', 'Skip the confirmation prompt (required when not on a terminal).')
        .option('--json', 'Print as JSON.')
        .addHelpText('after', `
<variant> is a variant name or its node code ("ef splits variants <id>" lists both).

Examples:
  $ ef splits variants 509
  $ ef splits winner 509 "Luis DF"
  $ ef splits winner 509 k3j9x2 --yes

This is a business decision, not a statistical one: it applies whether or not
"ef stats split <id>" has named a winner, and it prints the server's verdict
first so the call is made knowingly. The test is finalized and the winner is
written into the page/funnel graph, so pull that graph afterwards before
editing it ("ef pages events pull <slug>" / "ef funnels pull <code>").`)
        .action(async (id: string, variant: string, opts: { yes?: boolean; json?: boolean }) => {
            const splitTestId = Number(id);
            if (!Number.isInteger(splitTestId) || splitTestId <= 0) throw new CliError(ExitCode.Validation, 'Pass a numeric split test id.');

            const rt = await loadRuntime();
            const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
            const [test, arms] = await Promise.all([
                api.getSplitTest(rt.config.brandId, splitTestId),
                api.getSplitTestNodeCodes(rt.config.brandId, splitTestId),
            ]);
            const arm = resolveVariant(arms, variant);

            const status = String(test.status ?? '');
            if (status === 'deleted') throw new CliError(ExitCode.Validation, `Split test #${splitTestId} is deleted.`);
            if (status === 'finalized') {
                throw new CliError(ExitCode.Conflict, `Split test #${splitTestId} is already finalized. "ef stats split ${splitTestId}" shows its result.`);
            }

            if (!opts.json) {
                log.info(`${c.bold(test.name ?? `Split test ${splitTestId}`)} ${c.dim(`(#${splitTestId})`)} → winner ${c.bold(arm.name)} ${c.dim(arm.code)}`);
                // The server's verdict, shown so an early call is a deliberate one.
                const verdict = await api.getSplitTestSignificance(
                    rt.config.brandId, splitTestId,
                    (test.start_date ?? '').slice(0, 10) || new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10),
                    new Date().toISOString().slice(0, 10),
                ).catch(() => null);
                if (verdict?.winner) {
                    log.detail(`Server verdict: ${verdict.winner} won.`);
                } else if (verdict) {
                    log.warn(`The server has not named a winner (p-value ${verdict.pvalue != null ? verdict.pvalue.toFixed(4) : '—'}${verdict.sample_size_for_significance != null ? `, ~${verdict.sample_size_for_significance} sessions per arm needed` : ''}). This is a manual call.`);
                }
            }

            if (!opts.yes) {
                if (!process.stdin.isTTY) {
                    throw new CliError(ExitCode.Validation, 'Declaring a winner ends the test for every visitor. Re-run with --yes to confirm.');
                }
                const { confirm } = await import('../utils/prompt');
                if (!(await confirm(`Finalize #${splitTestId} and send all traffic to "${arm.name}"?`, false))) {
                    throw new CliError(ExitCode.Validation, 'Aborted.');
                }
            }

            const updated = await api.declareSplitTestWinner(rt.config.brandId, splitTestId, arm.code);

            if (opts.json) {
                log.json({ ok: true, split_test: { id: splitTestId, name: test.name, status: updated.status ?? 'finalized' }, winner: arm });
                return;
            }
            log.success(`#${splitTestId} finalized — all traffic now goes to "${arm.name}".`);
            const graphHint = test.page?.slug
                ? `ef pages events pull ${test.page.slug}`
                : test.funnel?.code ? `ef funnels pull ${test.funnel.code}` : null;
            if (graphHint) log.detail(`The graph changed on the server — run "${graphHint}" before editing it.`);
            log.detail('Record the outcome in elasticfunnels/split-tests.md.');
        });
}
