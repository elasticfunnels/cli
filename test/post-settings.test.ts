import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Command } from 'commander';
import { addPostSettingsOptions, buildPostSettings, hasPostFlags } from '../src/commands/postSettings';
import { CliError } from '../src/utils/exit';

/**
 * `ef pages settings --post-*` (T1120-10): the card details a site's post lists show.
 * One flag must change only its own key: the autoblog sets the cover on one call and
 * the tags on another, and a wiped card would drop a post's image from every list.
 */

const current = { cover: '/img/a.webp', tags: ['Growth'], read: '9 min read', extra: { color: 'peach' } };

test('one flag changes only its key and keeps the rest', () => {
    assert.deepEqual(buildPostSettings({ postTags: 'Ads, Growth,' }, current), {
        post_meta: { cover: '/img/a.webp', tags: ['Ads', 'Growth'], read: '9 min read', extra: { color: 'peach' } },
    });
});

test('none clears a key; clearing the last one clears the card', () => {
    assert.deepEqual(buildPostSettings({ postCover: 'none' }, { cover: '/x.webp' }), { post_meta: '' });
    assert.deepEqual(buildPostSettings({ postRead: 'none', postTags: 'none' }, current).post_meta, { cover: '/img/a.webp', extra: { color: 'peach' } });
});

test('dates are checked', () => {
    assert.deepEqual(buildPostSettings({ postDate: '2026-10-21' }, null), { published_at: '2026-10-21' });
    assert.deepEqual(buildPostSettings({ postDate: 'none' }, null), { published_at: '' });
    assert.throws(() => buildPostSettings({ postDate: '21/10/2026' }, null), CliError);
    assert.throws(() => buildPostSettings({ postPinnedUntil: 'soon' }, null), CliError);
    assert.deepEqual(buildPostSettings({ postPinnedUntil: '2026-12-01' }, null).post_meta, { pinned_until: '2026-12-01' });
});

test('flags, extra fields and a whole-card replace', () => {
    assert.deepEqual(buildPostSettings({ postFeatured: true, postHidden: false, postExtra: ['color=', 'cover_style=banner'] }, { ...current, hidden: true }).post_meta,
        { cover: '/img/a.webp', tags: ['Growth'], read: '9 min read', extra: { cover_style: 'banner' }, featured: true });
    assert.deepEqual(buildPostSettings({ postMeta: '{"tags":["X"]}', postRead: '3 min read' }, current).post_meta, { tags: ['X'], read: '3 min read' });
    assert.throws(() => buildPostSettings({ postMeta: '[1]' }, null), CliError);
    // --post-set: a site's card writer sets its fields and keeps what the editor set (hidden, related, extra keys)
    assert.deepEqual(
        buildPostSettings({ postSet: '{"title":"T","tags":["Light, heat and power"],"extra":{"cover_w":"800"}}' },
            { hidden: true, related: ['a'], title: 'old', extra: { color: 'sky', cover_w: '600' } }).post_meta,
        { hidden: true, related: ['a'], title: 'T', tags: ['Light, heat and power'], extra: { color: 'sky', cover_w: '800' } });
    assert.throws(() => buildPostSettings({ postSet: '"x"' }, null), CliError);
    assert.throws(() => buildPostSettings({ postExtra: ['Bad Key=x'] }, null), CliError);
});

test('no post flag sends nothing', () => {
    assert.deepEqual(buildPostSettings({}, current), {});
    assert.equal(hasPostFlags({}), false);
    assert.equal(hasPostFlags({ postFeatured: false }), true);
});

test('the flags parse on a command', () => {
    const cmd = addPostSettingsOptions(new Command('settings').exitOverride());
    cmd.parse(['--post-tags', 'A,B', '--no-post-featured', '--post-extra', 'a=1', '--post-extra', 'b=2'], { from: 'user' });
    const o = cmd.opts();
    assert.equal(o.postTags, 'A,B');
    assert.equal(o.postFeatured, false);
    assert.deepEqual(o.postExtra, ['a=1', 'b=2']);
    assert.equal(o.postHidden, undefined, 'an unset --no- flag stays undefined');
});
