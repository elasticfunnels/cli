/**
 * Link warnings the app returns after a page save (PageEditorController, `link_warnings`):
 * the same list the app's page list shows behind the warning triangle. `error` items are
 * links that lose sales or show nothing; `hint` items are pasted buy links that would be
 * better as a [BUY=CODE] tag.
 */
export interface PageLinkWarning {
    level: 'error' | 'hint' | string;
    type: 'pasted_link' | 'other_account' | 'tracking_off' | 'unmapped_product' | string;
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
        case 'other_account':
            return w.account
                ? `${gateway} buy link goes to account ${w.account}, which is not one of this brand's merchants. Those sales will not reach ElasticFunnels.`
                : `${gateway} buy link pasted into the page, but this brand has no ${gateway} merchant. Those sales will not reach ElasticFunnels.`;
        case 'tracking_off':
            return `${gateway} buy link pasted into the page while click tracking for pasted links is off on the ${gateway} merchant, so those sales cannot be tied to a visit.`;
        case 'unmapped_product':
            return `Product code ${w.code ?? ''} matches no product in this brand, so its buy link shows nothing.`;
        default:
            return `Link warning: ${w.type}`;
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
