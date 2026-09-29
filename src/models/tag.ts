/**
 * A brand tag — the coloured label the dashboard renders in its list views.
 *
 * Tags are ONE flat table per brand (`brand_tags`) plus a join row per tagged
 * record (`brand_tag_items`, keyed by `module_key` + `item_id`). The same tag
 * can therefore sit on a page and on a component; there is no per-kind tag
 * namespace.
 */
export interface BrandTag {
    id: number;
    brand_id?: number;
    name: string;
    /** CSS colour as stored. The dashboard writes `rgb(r,g,b)`; hex also renders. */
    color?: string | null;
    /** Private-to-its-author flag. The CLI never sets it — see TAGGABLE below. */
    user_only?: boolean | number | null;
    /**
     * `1` when the listing was scoped to one record and this tag is on it.
     * ABSENT from an unscoped listing — which is not the same as "not assigned",
     * so never read it as a boolean off `ef tags list`.
     */
    assigned?: number | boolean | null;
}

/**
 * The record kinds this CLI tags, and the `module_key` each stores under.
 *
 * Deliberately just these two. The tags table itself is generic — the app
 * writes rows for products, funnels, domains and more — but only the Pages and
 * Components lists actually pass `has-tags`, so those are the only two places a
 * tag is ever VISIBLE. Tagging anything else would write a row nobody can see.
 */
export const TAGGABLE = {
    page: 'pages',
    component: 'pagecomponents',
} as const;

export type TaggableKind = keyof typeof TAGGABLE;

/**
 * The dashboard's colour swatches, by name.
 *
 * These are the exact eight the "Manage tags" modal offers, so a tag made from
 * the CLI is indistinguishable from one made in the app. `coral` is the brand
 * accent and `black` is inverted — both are loud, so neither is ever chosen
 * automatically; they are opt-in via `--color`.
 */
export const TAG_COLORS: Record<string, string> = {
    grey: 'rgb(244,244,245)',
    silver: 'rgb(228,228,231)',
    blue: 'rgb(219,234,254)',
    green: 'rgb(209,250,229)',
    yellow: 'rgb(254,249,195)',
    peach: 'rgb(255,237,231)',
    coral: 'rgb(255,90,54)',
    black: 'rgb(39,39,42)',
};

/** Soft tints an auto-assigned colour is drawn from. Order is part of the hash. */
export const TAG_AUTO_COLORS: readonly string[] = [
    TAG_COLORS.blue,
    TAG_COLORS.green,
    TAG_COLORS.yellow,
    TAG_COLORS.peach,
    TAG_COLORS.silver,
];
