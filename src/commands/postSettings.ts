import { Command } from 'commander';
import { CliError, ExitCode } from '../utils/exit';

/**
 * Blog post settings on `ef pages settings` (T1120-10): the post's date and the card details
 * the site's lists show (getPosts() on the runtime). Stored server-side as published_at and
 * post_meta; every flag changes only its own key and keeps the rest.
 */
export interface PostSettingsOpts {
    postDate?: string;
    postCover?: string;
    postTags?: string;
    postRead?: string;
    postTitle?: string;
    postExcerpt?: string;
    postRelated?: string;
    postFeatured?: boolean;
    postPinnedUntil?: string;
    postHidden?: boolean;
    postExtra?: string[];
    postMeta?: string;
}

export function addPostSettingsOptions(cmd: Command): Command {
    return cmd
        .option('--post-date <YYYY-MM-DD|none>', 'Blog post: the date it shows and sorts by (set by itself on first publish).')
        .option('--post-cover <path|none>', 'Blog post: card cover image ("/img/blog/x-cover.webp" or a URL).')
        .option('--post-tags <tags|none>', 'Blog post: tags, comma separated; the first is the main one.')
        .option('--post-read <text|none>', 'Blog post: reading time ("9 min read").')
        .option('--post-title <text|none>', 'Blog post: card title (default: the page title).')
        .option('--post-excerpt <text|none>', 'Blog post: card text (default: the SEO description).')
        .option('--post-related <slugs|none>', 'Blog post: related posts shown first under it, comma separated.')
        .option('--post-featured', 'Blog post: the featured (lead) card on the blog page.')
        .option('--no-post-featured', 'Blog post: not featured.')
        .option('--post-pinned-until <YYYY-MM-DD|none>', 'Blog post: lead the blog page until this day (UTC).')
        .option('--post-hidden', 'Blog post: keep it off every list (the page stays live).')
        .option('--no-post-hidden', 'Blog post: list it again.')
        .option('--post-extra <key=value>', 'Blog post: a site\'s own card field (repeatable; "key=" removes it).', (v: string, prev: string[] = []) => [...prev, v])
        .option('--post-meta <json|none>', 'Blog post: replace all card details with this JSON object.');
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isNone = (v: string) => /^(none|null|-)$/i.test(v.trim());
const splitList = (v: string) => v.split(',').map(s => s.trim()).filter(Boolean);

/**
 * The payload fields for the post flags given, merged onto the page's current post_meta.
 * Returns {} when no post flag was passed.
 */
export function buildPostSettings(opts: PostSettingsOpts, current: Record<string, unknown> | null | undefined): { post_meta?: Record<string, unknown> | ''; published_at?: string | '' } {
    const out: { post_meta?: Record<string, unknown> | ''; published_at?: string | '' } = {};

    if (opts.postDate !== undefined) {
        if (isNone(opts.postDate)) out.published_at = '';
        else if (DATE_RE.test(opts.postDate.trim())) out.published_at = opts.postDate.trim();
        else throw new CliError(ExitCode.Validation, `--post-date must be YYYY-MM-DD or "none", got "${opts.postDate}".`);
    }

    let meta: Record<string, unknown>;
    let touched = false;
    if (opts.postMeta !== undefined) {
        touched = true;
        if (isNone(opts.postMeta)) {
            meta = {};
        } else {
            let parsed: unknown;
            try {
                parsed = JSON.parse(opts.postMeta);
            } catch {
                throw new CliError(ExitCode.Validation, '--post-meta must be a JSON object.');
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CliError(ExitCode.Validation, '--post-meta must be a JSON object.');
            meta = { ...(parsed as Record<string, unknown>) };
        }
    } else {
        meta = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
    }

    const text = (key: string, value: string | undefined) => {
        if (value === undefined) return;
        touched = true;
        if (isNone(value) || value.trim() === '') delete meta[key];
        else meta[key] = value.trim();
    };
    const listOf = (key: string, value: string | undefined) => {
        if (value === undefined) return;
        touched = true;
        const items = isNone(value) ? [] : splitList(value);
        if (items.length) meta[key] = items;
        else delete meta[key];
    };
    const flag = (key: string, value: boolean | undefined) => {
        if (value === undefined) return;
        touched = true;
        if (value) meta[key] = true;
        else delete meta[key];
    };

    text('cover', opts.postCover);
    listOf('tags', opts.postTags);
    text('read', opts.postRead);
    text('title', opts.postTitle);
    text('excerpt', opts.postExcerpt);
    listOf('related', opts.postRelated);
    flag('featured', opts.postFeatured);
    flag('hidden', opts.postHidden);
    if (opts.postPinnedUntil !== undefined) {
        if (!isNone(opts.postPinnedUntil) && !DATE_RE.test(opts.postPinnedUntil.trim())) {
            throw new CliError(ExitCode.Validation, `--post-pinned-until must be YYYY-MM-DD or "none", got "${opts.postPinnedUntil}".`);
        }
        text('pinned_until', opts.postPinnedUntil);
    }
    if (opts.postExtra && opts.postExtra.length) {
        touched = true;
        const extra = meta.extra && typeof meta.extra === 'object' && !Array.isArray(meta.extra) ? { ...(meta.extra as Record<string, unknown>) } : {};
        for (const pair of opts.postExtra) {
            const eq = pair.indexOf('=');
            if (eq < 1) throw new CliError(ExitCode.Validation, `--post-extra takes key=value, got "${pair}".`);
            const key = pair.slice(0, eq).trim();
            const value = pair.slice(eq + 1);
            if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) throw new CliError(ExitCode.Validation, `--post-extra key "${key}" must be lower_snake_case.`);
            if (value === '') delete extra[key];
            else extra[key] = value;
        }
        if (Object.keys(extra).length) meta.extra = extra;
        else delete meta.extra;
    }

    if (touched) out.post_meta = Object.keys(meta).length ? meta : '';
    return out;
}

export function hasPostFlags(opts: PostSettingsOpts): boolean {
    return [opts.postDate, opts.postCover, opts.postTags, opts.postRead, opts.postTitle, opts.postExcerpt, opts.postRelated,
        opts.postFeatured, opts.postPinnedUntil, opts.postHidden, opts.postMeta].some(v => v !== undefined)
        || Boolean(opts.postExtra && opts.postExtra.length);
}

/** One line per post setting for the human output. */
export function describePostSettings(sent: { post_meta?: Record<string, unknown> | ''; published_at?: string | '' }): string[] {
    const lines: string[] = [];
    if (sent.published_at !== undefined) lines.push(sent.published_at ? `  Post date → ${sent.published_at}` : '  Post date cleared (lists use the creation date).');
    if (sent.post_meta !== undefined) {
        if (!sent.post_meta) lines.push('  Post card details cleared.');
        else lines.push(`  Post card: ${Object.entries(sent.post_meta).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('; ')}`);
    }
    return lines;
}
