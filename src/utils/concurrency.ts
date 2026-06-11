/**
 * Bounded-concurrency map. Runs `worker(item)` for every entry of `items`,
 * with at most `concurrency` promises in flight at any time. Preserves
 * input order in the returned array.
 *
 * Why not Promise.all? `pullAllPages` against a thousand-page brand would
 * fan out a thousand simultaneous HTTP requests and trip the upstream
 * rate limit. Capping at ~8 keeps the throughput vs. politeness balance
 * sensible for ElasticFunnels' API and for the user's terminal output
 * pacing.
 */
export async function mapWithConcurrency<TIn, TOut>(
    items: readonly TIn[],
    concurrency: number,
    worker: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
    const limit = Math.max(1, Math.floor(concurrency));
    const results: TOut[] = new Array(items.length);
    let cursor = 0;

    async function runOne(): Promise<void> {
        for (;;) {
            const i = cursor++;
            if (i >= items.length) return;
            results[i] = await worker(items[i], i);
        }
    }

    const lanes = Math.min(limit, items.length);
    const workers: Promise<void>[] = [];
    for (let i = 0; i < lanes; i++) workers.push(runOne());
    await Promise.all(workers);
    return results;
}

/**
 * Default concurrency for batch sync operations. Picked empirically:
 * higher than this just queues up against axios' default keep-alive
 * pool without measurable wall-clock improvement, but does noticeably
 * raise the chance of hitting the per-IP rate limit on shared API hosts.
 */
export const DEFAULT_PULL_CONCURRENCY = 8;
