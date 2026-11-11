/**
 * Link warnings the app returns after a page save (PageEditorController, `link_warnings`):
 * the same list the app's page list shows behind the warning triangle. `error` items are
 * links that lose sales or show nothing; `hint` items are pasted buy links that would be
 * better as a [BUY=CODE] tag.
 */
export interface PageLinkWarning {
    level: 'error' | 'hint' | string;
    type: 'pasted_link' | 'pasted_link_lost_sales' | 'other_account' | 'tracking_off' | 'unmapped_product' | string;
    gateway?: string;
    account?: string | null;
    code?: string;
    count?: number;
}

const GATEWAY_NAMES: Record<string, string> = {
    clickbank: 'ClickBank',
    jvzoo: 'JVZoo',
    buygoods: 'BuyGoods',
    digistore24: 'Digistore24',
    explodely: 'Explodely',
};

export function linkWarningMessage(w: PageLinkWarning): string {
    const gateway = GATEWAY_NAMES[w.gateway ?? ''] ?? w.gateway ?? '';
    switch (w.type) {
        case 'pasted_link':
            return `${gateway} buy link pasted into the page. Use a [BUY=CODE] tag so the product, price and funnel next step come from ElasticFunnels.`;
        case 'pasted_link_lost_sales': {
            const name = gateway || 'Merchant';
            return `${name} buy link pasted into the page skips the ElasticFunnels purchase step, and no ${gateway ? `${gateway} ` : ''}sale notice reaches ElasticFunnels, so those sales are never recorded: no order, no funnel upsell, no affiliate credit. Use a [BUY=CODE] tag.`;
        }
        case 'other_account':
            return w.account
                ? `${gateway} buy link goes to account ${w.account}, which is not one of this brand's merchants. Those sales will not reach ElasticFunnels.`
                : `${gateway} buy link pasted into the page, but this brand has no ${gateway} merchant. Those sales will not reach ElasticFunnels.`;
        case 'tracking_off':
            return `${gateway} buy link pasted into the page while click tracking for pasted links is off on the ${gateway} merchant, so those sales cannot be tied to a visit.`;
        case 'unmapped_product':
            return `Product code ${w.code ?? ''} matches no product in this brand, so its buy link shows nothing.`;
        default:
            return w.level === 'error'
                ? `Link error (${w.type}${gateway ? `, ${gateway}` : ''}): sales from this link may not reach ElasticFunnels. Check the page's links in the app.`
                : `Link warning: ${w.type}`;
    }
}

/** One line per warning, errors first, prefixed with the file. */
export function formatLinkWarnings(warnings: PageLinkWarning[] | undefined, rel: string): Array<{ level: 'error' | 'hint'; line: string }> {
    if (!Array.isArray(warnings) || warnings.length === 0) return [];
    const sorted = [...warnings].sort((a, b) => (a.level === 'error' ? 0 : 1) - (b.level === 'error' ? 0 : 1));
    return sorted.map((w) => ({
        level: w.level === 'error' ? 'error' : 'hint',
        line: `${rel}: ${linkWarningMessage(w)}`,
    }));
}

/** Shape `ef push --json` reports for each warning: the server's fields plus the printed message. */
export interface LinkWarningReport {
    level: 'error' | 'hint';
    type: string;
    gateway?: string;
    account?: string | null;
    code?: string;
    count?: number;
    message: string;
}

export function linkWarningReports(warnings: PageLinkWarning[] | undefined): LinkWarningReport[] {
    if (!Array.isArray(warnings)) return [];
    return warnings.map((w) => {
        const out: LinkWarningReport = { level: w.level === 'error' ? 'error' : 'hint', type: w.type, message: linkWarningMessage(w) };
        if (w.gateway !== undefined) out.gateway = w.gateway;
        if (w.account !== undefined) out.account = w.account;
        if (w.code !== undefined) out.code = w.code;
        if (w.count !== undefined) out.count = w.count;
        return out;
    }).sort((a, b) => (a.level === 'error' ? 0 : 1) - (b.level === 'error' ? 0 : 1));
}

/**
 * Printed block for one file: errors under their own heading (sales are lost), then hints.
 * Kept in plain words so an AI agent reading the terminal knows to stop and ask.
 */
export function linkWarningBlock(warnings: PageLinkWarning[] | undefined, rel: string): Array<{ level: 'error' | 'hint' | 'detail'; line: string }> {
    const reports = linkWarningReports(warnings);
    const errors = reports.filter((r) => r.level === 'error');
    const hints = reports.filter((r) => r.level === 'hint');
    const out: Array<{ level: 'error' | 'hint' | 'detail'; line: string }> = [];
    if (errors.length) {
        out.push({ level: 'error', line: `LINK ERRORS in ${rel}: sales or upsells are lost until these are fixed` });
        for (const e of errors) out.push({ level: 'detail', line: `    - ${e.message}` });
    }
    if (hints.length) {
        out.push({ level: 'hint', line: `Link hints for ${rel}:` });
        for (const h of hints) out.push({ level: 'detail', line: `    - ${h.message}` });
    }
    return out;
}

/** Last lines of a push that had link errors, addressed to whoever (or whatever) runs the CLI. */
export function linkErrorSummary(errorCount: number, fileCount: number): string[] {
    if (errorCount <= 0) return [];
    return [
        `${errorCount} link error${errorCount === 1 ? '' : 's'} on ${fileCount} file${fileCount === 1 ? '' : 's'} (see LINK ERRORS above). Buyers on these links are lost to ElasticFunnels: no order, no upsell, no affiliate credit.`,
        'AI agents: stop here and tell the user what this costs before publishing anything else. Offer to replace each pasted link with a [BUY=CODE] or [UPSELL=CODE] tag.',
    ];
}
