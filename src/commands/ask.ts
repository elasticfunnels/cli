import { Command } from 'commander';
import axios from 'axios';
import { CliError, ExitCode } from '../utils/exit';
import { log } from '../utils/log';
import { loadRuntime } from '../utils/store';

function cliVersion(): string {
    try {
        return require('../../package.json').version as string;
    } catch {
        return '0.0.0';
    }
}

export function registerAskCommand(program: Command): void {
    program
        .command('ask')
        .description(
            'Search the ElasticFunnels knowledge base through the app API. ' +
            'Uses EF-Access-Key from `ef init` — no extra token needed.',
        )
        .argument('[query...]', 'Search terms')
        .option('-l, --limit <n>', 'Max hits (1–25, default 8)', '8')
        .option('-m, --mode <mode>', 'atoms | chunks', 'atoms')
        .option('-c, --cursor <cursor>', 'Pagination cursor from a previous response')
        .option('-k, --kind <kinds>', 'Comma-separated atom kind filter')
        .option('--json', 'Emit JSON on stdout (same shape as API).')
        .action(async (
            queryParts: string[],
            opts: { limit: string; mode: string; cursor?: string; kind?: string; json?: boolean },
        ) => {
            const rt = await loadRuntime();
            const q = queryParts.join(' ').trim();
            if (!q) {
                throw new CliError(ExitCode.Validation, 'Missing query. Example: ef ask billing dunning');
            }

            let limitNum = parseInt(opts.limit, 10);
            if (!Number.isFinite(limitNum)) limitNum = 8;
            limitNum = Math.min(25, Math.max(1, limitNum));

            const mode = opts.mode === 'chunks' ? 'chunks' : 'atoms';
            const base = rt.config.apiUrl.replace(/\/$/, '');
            const url = `${base}/api/brands/${rt.config.brandId}/knowledge/search`;

            const params: Record<string, string | number> = { q, limit: limitNum, mode };
            if (opts.cursor?.trim()) params.cursor = opts.cursor.trim();
            if (opts.kind?.trim()) params.kind = opts.kind.trim();

            try {
                const res = await axios.get<unknown>(url, {
                    params,
                    headers: {
                        Accept: 'application/json',
                        'EF-Access-Key': rt.apiKey,
                        'User-Agent': `ef-cli/${cliVersion()}`,
                    },
                    timeout: 90000,
                    validateStatus: () => true,
                });

                if (res.status === 401 || res.status === 403) {
                    throw new CliError(
                        ExitCode.Auth,
                        `Rejected by app API (${res.status}). Check EF-Access-Key and brand id.`,
                    );
                }
                if (res.status === 429) {
                    throw new CliError(
                        ExitCode.Error,
                        'Rate limited — try again in a minute.',
                    );
                }
                if (res.status === 503 || res.status === 502) {
                    const msg =
                        typeof (res.data as { message?: string } | undefined)?.message === 'string'
                            ? (res.data as { message: string }).message
                            : `Knowledge backend unavailable (${res.status}).`;
                    throw new CliError(ExitCode.Server, msg);
                }
                if (res.status >= 500) {
                    throw new CliError(
                        ExitCode.Server,
                        `Knowledge search failed (HTTP ${res.status}).`,
                    );
                }
                if (res.status >= 400) {
                    let detail = '';
                    const data = res.data as { message?: string } | undefined;
                    if (data?.message) detail = data.message;
                    else detail = typeof res.data === 'string'
                        ? res.data.slice(0, 800)
                        : JSON.stringify(res.data).slice(0, 800);
                    throw new CliError(
                        ExitCode.Error,
                        `Knowledge search failed (HTTP ${res.status}): ${detail || res.statusText}`,
                    );
                }

                const payload = res.data;
                if (opts.json) {
                    log.json(payload);
                    return;
                }
                console.log(JSON.stringify(payload, null, 2));
            } catch (err) {
                if (err instanceof CliError) throw err;
                if (axios.isAxiosError(err) && !err.response) {
                    throw new CliError(
                        ExitCode.Network,
                        `Could not reach ${base} (${err.code ?? err.message}).`,
                    );
                }
                throw err;
            }
        });
}
