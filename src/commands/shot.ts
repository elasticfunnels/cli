import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Browser, Page as PwPage } from 'playwright-core';
import { ApiClient } from '../api/client';
import { CliError, ExitCode } from '../utils/exit';
import { log } from '../utils/log';
import { safeText } from '../utils/sanitize';
import { findProjectRoot, loadRuntime, CONFIG_DIR } from '../utils/store';
import { fetchPagePreviewBundle, resolvePageBySlug } from './shared';
import { isOfflineStatus, offlinePageNote } from '../sync/sync';

/**
 * `ef shot` takes a screenshot of a page's current draft (default) or its
 * published version (--live) in a local headless Chromium. Full page by
 * default; --selector for one section, --viewport for the first screen.
 * Also takes any http(s) URL instead of a page.
 */

export interface ShotSize {
    name: string;
    width: number;
    height: number;
    mobile: boolean;
}

export const SIZE_PRESETS: Record<string, ShotSize> = {
    desktop: { name: 'desktop', width: 1440, height: 900, mobile: false },
    laptop: { name: 'laptop', width: 1280, height: 800, mobile: false },
    tablet: { name: 'tablet', width: 820, height: 1180, mobile: true },
    mobile: { name: 'mobile', width: 390, height: 844, mobile: true },
};

/** `desktop`, `mobile`, `1280x720`, or a comma list of those. */
export function parseSizes(spec: string): ShotSize[] {
    const out: ShotSize[] = [];
    for (const raw of spec.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
        if (raw === 'both') {
            out.push(SIZE_PRESETS.desktop, SIZE_PRESETS.mobile);
            continue;
        }
        const preset = SIZE_PRESETS[raw];
        if (preset) {
            out.push(preset);
            continue;
        }
        const m = /^(\d{2,5})x(\d{2,5})$/.exec(raw);
        if (!m) {
            throw new CliError(ExitCode.Validation, `Bad --size "${raw}". Use desktop, laptop, tablet, mobile, both, or WIDTHxHEIGHT (e.g. 1280x720).`);
        }
        const width = Number(m[1]);
        const height = Number(m[2]);
        if (width < 200 || width > 7680 || height < 200 || height > 8000) {
            throw new CliError(ExitCode.Validation, `--size ${raw} is out of range (200-7680 wide, 200-8000 high).`);
        }
        out.push({ name: `${width}x${height}`, width, height, mobile: width < 768 });
    }
    if (out.length === 0) throw new CliError(ExitCode.Validation, '--size is empty.');
    return out;
}

/** Vertical slices [y, height] covering a page of `total` px in pieces of `chunk` px. */
export function chunkPlan(total: number, chunk: number): Array<{ y: number; height: number }> {
    if (chunk <= 0 || total <= chunk) return [{ y: 0, height: total }];
    const out: Array<{ y: number; height: number }> = [];
    for (let y = 0; y < total; y += chunk) out.push({ y, height: Math.min(chunk, total - y) });
    return out;
}

/** `--chunk auto`: pieces short enough to read as one image (1500 px wide screens, 1300 px phones). */
export function resolveChunk(spec: string, size: ShotSize): number {
    if (spec.trim().toLowerCase() === 'auto') return size.width < 768 ? 1300 : 1500;
    const n = Number(spec);
    if (!Number.isInteger(n) || n < 0 || n > 20000) throw new CliError(ExitCode.Validation, '--chunk must be auto or a whole number from 0 to 20000.');
    return n;
}

/** Old images of this page and size (`<base>-<size>.png`, `<base>-<size>-<n>.png`), so a shorter page leaves no stale pieces. */
export function staleShots(files: string[], base: string, sizeName: string, ext: string): string[] {
    const stem = shotFileName(base, sizeName, ext, null).slice(0, -(ext.length + 1));
    const re = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-\\d+)?\\.${ext}$`);
    return files.filter((f) => re.test(f));
}

/** What sticks out past the right edge: up to 5 of the outermost elements, as tag#id.class. */
const OVERFLOW_JS = `(() => {
    const w = document.documentElement.clientWidth;
    const out = [];
    const seen = new Set();
    for (const el of document.body ? document.body.querySelectorAll('*') : []) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.right <= w + 1) continue;
        let p = el.parentElement, inside = false;
        while (p) { if (seen.has(p)) { inside = true; break; } p = p.parentElement; }
        if (inside) continue;
        seen.add(el);
        const cls = (typeof el.className === 'string' ? el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
        out.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '') + ' (' + Math.round(r.right) + 'px)');
        if (out.length >= 5) break;
    }
    return { scrollWidth: document.documentElement.scrollWidth, clientWidth: w, culprits: out, viewportMeta: !!document.querySelector('meta[name="viewport"]') };
})()`;

/** Output file for one capture; `-<n>` is added per chunk. */
export function shotFileName(base: string, sizeName: string, ext: string, chunkIndex: number | null): string {
    const safe = base.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'page';
    return `${safe}-${sizeName}${chunkIndex == null ? '' : `-${chunkIndex + 1}`}.${ext}`;
}

/** A Chromium to drive: EF_CHROME_PATH, Playwright's cached browsers, then an installed Chrome. */
export function findChromium(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string | null {
    if (env.EF_CHROME_PATH) return exists(env.EF_CHROME_PATH) ? env.EF_CHROME_PATH : null;
    const home = os.homedir();
    const caches = [
        env.PLAYWRIGHT_BROWSERS_PATH,
        path.join(home, 'Library', 'Caches', 'ms-playwright'),
        path.join(home, '.cache', 'ms-playwright'),
        env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'ms-playwright') : undefined,
    ].filter((p): p is string => !!p && p !== '0');
    const inner = [
        'chrome-headless-shell-mac-arm64/chrome-headless-shell',
        'chrome-headless-shell-mac-x64/chrome-headless-shell',
        'chrome-headless-shell-linux64/chrome-headless-shell',
        'chrome-headless-shell-win64/chrome-headless-shell.exe',
        'chrome-linux/headless_shell',
        'chrome-mac/headless_shell',
        'chrome-linux/chrome',
        'chrome-linux64/chrome',
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-win/chrome.exe',
    ];
    for (const cache of caches) {
        let dirs: string[] = [];
        try {
            dirs = fs.readdirSync(cache);
        } catch {
            continue;
        }
        // Newest first; the headless shell before the full browser.
        const rev = (d: string) => Number(d.split('-').pop()) || 0;
        const ordered = [
            ...dirs.filter((d) => d.startsWith('chromium_headless_shell-')).sort((a, b) => rev(b) - rev(a)),
            ...dirs.filter((d) => d.startsWith('chromium-')).sort((a, b) => rev(b) - rev(a)),
        ];
        for (const d of ordered) {
            for (const i of inner) {
                const p = path.join(cache, d, i);
                if (exists(p)) return p;
            }
        }
    }
    const system = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
    return system.find((p) => exists(p)) ?? null;
}

/** Where `ef shot --install` puts playwright-core when the CLI's own optional copy is missing. */
export function toolsDir(env: NodeJS.ProcessEnv = process.env): string {
    return env.EF_SHOT_TOOLS_DIR || path.join(os.homedir(), '.ef-cli', 'shot');
}

/** playwright-core from the CLI's install, else from toolsDir(); null when neither has it. */
export function tryLoadPlaywright(): { mod: typeof import('playwright-core'); from: string } | null {
    try {
        return { mod: require('playwright-core'), from: require.resolve('playwright-core') };
    } catch { /* not bundled */ }
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { createRequire } = require('module') as typeof import('module');
        const req = createRequire(path.join(toolsDir(), 'package.json'));
        return { mod: req('playwright-core'), from: req.resolve('playwright-core') };
    } catch {
        return null;
    }
}

export interface ShotReadiness {
    ready: boolean;
    playwright: string | null;
    chromium: string | null;
    fix: string | null;
}

export function shotReadiness(): ShotReadiness {
    const pw = tryLoadPlaywright();
    const chromium = findChromium();
    const missing: string[] = [];
    if (!pw) missing.push('playwright-core');
    if (!chromium) missing.push('a Chromium');
    return {
        ready: missing.length === 0,
        playwright: pw?.from ?? null,
        chromium,
        fix: missing.length ? `Missing ${missing.join(' and ')}. Run: ef shot --install` : null,
    };
}

function run(cmd: string, args: string[]): void {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawnSync } = require('child_process') as typeof import('child_process');
    const r = spawnSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' });
    if (r.status !== 0) throw new CliError(ExitCode.Error, `Failed: ${cmd} ${args.join(' ')}`);
}

/** Install what is missing: playwright-core into toolsDir(), then Playwright's headless Chromium. */
export function installShotTools(): ShotReadiness {
    let pw = tryLoadPlaywright();
    if (!pw) {
        const dir = toolsDir();
        fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(path.join(dir, 'package.json'))) fs.writeFileSync(path.join(dir, 'package.json'), '{"private":true}\n');
        log.info(`Installing playwright-core into ${dir} ...`);
        run('npm', ['install', '--prefix', dir, '--no-audit', '--no-fund', 'playwright-core@^1.56.0']);
        pw = tryLoadPlaywright();
        if (!pw) throw new CliError(ExitCode.Error, `playwright-core installed but cannot be loaded from ${dir}.`);
    }
    if (!findChromium()) {
        log.info('Installing Playwright\'s headless Chromium ...');
        const cli = path.join(path.dirname(pw.from), 'cli.js');
        run(process.execPath, [cli, 'install', 'chromium-headless-shell']);
    }
    return shotReadiness();
}

function loadPlaywright(): typeof import('playwright-core') {
    const pw = tryLoadPlaywright();
    if (!pw) throw new CliError(ExitCode.Error, 'ef shot needs playwright-core, which is not installed. Run: ef shot --install');
    return pw.mod;
}

interface ShotOpts {
    check?: boolean;
    install?: boolean;
    live?: boolean;
    size: string;
    selector?: string;
    viewport?: boolean;
    chunk: string;
    scale: string;
    wait: string;
    timeout: string;
    format: string;
    quality?: string;
    out?: string;
    json?: boolean;
}

export interface ShotTarget {
    url: string;
    label: string;
    kind: 'draft' | 'live' | 'url';
    pageId: number | null;
}

async function resolveTarget(ref: string, live: boolean): Promise<ShotTarget> {
    if (/^https?:\/\//i.test(ref)) return { url: ref, label: new URL(ref).hostname + new URL(ref).pathname, kind: 'url', pageId: null };
    const rt = await loadRuntime();
    const api = new ApiClient(rt.config.apiUrl, rt.apiKey);
    const page = await resolvePageBySlug(api, rt.config.brandId, ref);
    const slug = page.slug ?? String(page.id);
    if (isOfflineStatus(page.status)) throw new CliError(ExitCode.NotFound, offlinePageNote(slug));
    if (live) {
        const url = await api.getLiveUrl(rt.config.brandId, page.id);
        if (!url) throw new CliError(ExitCode.NotFound, `Page "${slug}" has no live URL (not published, or no domain on its funnel).`);
        return { url, label: `${slug}-live`, kind: 'live', pageId: page.id };
    }
    const bundle = await fetchPagePreviewBundle(api, rt.config.brandId, page.id);
    if (!bundle.previewUrl) throw new CliError(ExitCode.NotFound, offlinePageNote(slug));
    return { url: bundle.previewUrl, label: `${slug}-draft`, kind: 'draft', pageId: page.id };
}

function intOpt(name: string, v: string, min: number, max: number): number {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new CliError(ExitCode.Validation, `--${name} must be a whole number from ${min} to ${max}.`);
    return n;
}

/** Editor overlays the preview link adds (the "Elastic Debug" workbench and its toggle). */
export const HIDE_CSS = '#debug-window, #debug-window-toggle { display: none !important; }';

/** Scroll down in steps so lazy images and on-scroll animations load, then back to the top. */
async function settle(page: PwPage): Promise<void> {
    // A string, so the DOM code needs no DOM typings in this Node project.
    await page.evaluate(`(async () => {
        const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let y = 0, i = 0; y < document.documentElement.scrollHeight && i < 200; y += step, i++) {
            window.scrollTo(0, y);
            await sleep(120);
        }
        window.scrollTo(0, 0);
        await sleep(200);
    })()`);
}

export function registerShotCommand(program: Command): void {
    program
        .command('shot [slugOrUrl]')
        .description('Screenshot a page: its current draft (default) or the published page (--live). Full page unless --selector or --viewport. Also takes any http(s) URL.')
        .option('--check', 'Say whether screenshots work here (playwright-core + a Chromium), with the fix. Exit 1 when not.')
        .option('--install', 'Install what --check finds missing (playwright-core into ~/.ef-cli/shot, Playwright\'s headless Chromium).')
        .option('--live', 'Shoot the published page instead of the current draft.')
        .option('--size <spec>', 'desktop (1440x900), laptop, tablet, mobile (390x844), both, WIDTHxHEIGHT, or a comma list.', 'desktop')
        .option('--selector <css>', 'Shoot only the first element matching this CSS selector (a section).')
        .option('--viewport', 'Shoot only the first screen, not the full page.')
        .option('--chunk <px>', 'Split a full-page shot into pieces this tall so each stays readable. auto = 1500 (1300 on phones), 0 = one tall image.', 'auto')
        .option('--scale <n>', 'Device pixel ratio, 1-3.', '1')
        .option('--wait <ms>', 'Extra wait after load, before the shot.', '800')
        .option('--timeout <ms>', 'Page load timeout.', '45000')
        .option('--format <fmt>', 'png or jpeg.', 'png')
        .option('--quality <n>', 'JPEG quality 1-100.')
        .option('--out <dir>', 'Folder for the images (default: .ef/shots in the project, else the temp folder).')
        .option('--json', 'Print the files as JSON.')
        .action(async (ref: string | undefined, opts: ShotOpts) => {
            if (opts.check || opts.install) {
                const r = opts.install ? installShotTools() : shotReadiness();
                if (opts.json) log.json({ ok: r.ready, ...r });
                else {
                    log.info(`playwright-core: ${r.playwright ?? 'missing'}`);
                    log.info(`chromium:        ${r.chromium ?? 'missing'}`);
                    if (r.ready) log.success('ef shot is ready.');
                    else log.warn(r.fix ?? 'Not ready.');
                }
                if (!r.ready) process.exitCode = ExitCode.Error;
                if (!ref) return;
                if (!r.ready) return;
            }
            if (!ref) throw new CliError(ExitCode.Validation, 'Give a page slug, id or URL (or --check / --install).');
            const sizes = parseSizes(opts.size);
            for (const s of sizes) resolveChunk(opts.chunk, s);
            const scale = intOpt('scale', opts.scale, 1, 3);
            const wait = intOpt('wait', opts.wait, 0, 60000);
            const timeout = intOpt('timeout', opts.timeout, 1000, 300000);
            const format = opts.format.toLowerCase() === 'jpg' ? 'jpeg' : opts.format.toLowerCase();
            if (format !== 'png' && format !== 'jpeg') throw new CliError(ExitCode.Validation, '--format must be png or jpeg.');
            const quality = opts.quality != null ? intOpt('quality', opts.quality, 1, 100) : undefined;
            if (quality != null && format !== 'jpeg') throw new CliError(ExitCode.Validation, '--quality only applies to --format jpeg.');
            if (opts.selector && opts.viewport) throw new CliError(ExitCode.Validation, 'Use --selector or --viewport, not both.');

            const exe = findChromium();
            if (!exe) {
                throw new CliError(ExitCode.Error, 'No Chromium found. Run: ef shot --install (or install Google Chrome, or set EF_CHROME_PATH).');
            }
            const { chromium } = loadPlaywright();
            const target = await resolveTarget(ref, !!opts.live);
            const root = findProjectRoot();
            const outDir = path.resolve(opts.out ?? (root ? path.join(root, CONFIG_DIR, 'shots') : path.join(os.tmpdir(), 'ef-shots')));
            fs.mkdirSync(outDir, { recursive: true });

            const ext = format === 'jpeg' ? 'jpg' : 'png';
            const files: Array<{ size: string; file: string; width: number; height: number }> = [];
            const pages: Array<{ size: string; viewport: number; height: number; scrollWidth: number; overflowX: boolean; overflowing: string[]; noViewportMeta: boolean }> = [];
            let browser: Browser | null = null;
            try {
                browser = await chromium.launch({ executablePath: exe, headless: true });
                for (const size of sizes) {
                    const ctx = await browser.newContext({
                        viewport: { width: size.width, height: size.height },
                        deviceScaleFactor: scale,
                        isMobile: size.mobile,
                        hasTouch: size.mobile,
                    });
                    const page = await ctx.newPage();
                    const res = await page.goto(target.url, { waitUntil: 'load', timeout });
                    if (res && res.status() >= 400) {
                        throw new CliError(res.status() === 404 ? ExitCode.NotFound : ExitCode.Server, `${target.url} answered HTTP ${res.status()}.`);
                    }
                    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
                    // The draft preview draws the editor's debug toolbar over the page.
                    await page.addStyleTag({ content: HIDE_CSS }).catch(() => undefined);
                    if (!opts.viewport) await settle(page);
                    if (wait) await page.waitForTimeout(wait);
                    const m = (await page.evaluate(OVERFLOW_JS)) as { scrollWidth: number; clientWidth: number; culprits: string[]; viewportMeta: boolean };
                    const pageHeight = Number(await page.evaluate('Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)'));
                    const overflowX = m.scrollWidth > m.clientWidth + 1;
                    pages.push({ size: size.name, viewport: size.width, height: pageHeight, scrollWidth: m.scrollWidth, overflowX, overflowing: overflowX ? m.culprits : [], noViewportMeta: size.mobile && !m.viewportMeta });
                    for (const old of staleShots(fs.readdirSync(outDir), target.label, size.name, ext)) fs.rmSync(path.join(outDir, old), { force: true });
                    const shotOpts = { type: format as 'png' | 'jpeg', ...(quality != null ? { quality } : {}), animations: 'disabled' as const };

                    if (opts.selector) {
                        const el = page.locator(opts.selector).first();
                        if ((await page.locator(opts.selector).count()) === 0) {
                            throw new CliError(ExitCode.NotFound, `No element matches --selector "${opts.selector}" on ${target.label}.`);
                        }
                        const file = path.join(outDir, shotFileName(target.label, size.name, ext, null));
                        await el.screenshot({ ...shotOpts, path: file });
                        const box = await el.boundingBox();
                        files.push({ size: size.name, file, width: Math.round(box?.width ?? 0), height: Math.round(box?.height ?? 0) });
                    } else if (opts.viewport) {
                        const file = path.join(outDir, shotFileName(target.label, size.name, ext, null));
                        await page.screenshot({ ...shotOpts, path: file });
                        files.push({ size: size.name, file, width: size.width, height: size.height });
                    } else {
                        const plan = chunkPlan(pageHeight, resolveChunk(opts.chunk, size));
                        for (let i = 0; i < plan.length; i++) {
                            const file = path.join(outDir, shotFileName(target.label, size.name, ext, plan.length > 1 ? i : null));
                            if (plan.length === 1) await page.screenshot({ ...shotOpts, path: file, fullPage: true });
                            else await page.screenshot({ ...shotOpts, path: file, fullPage: true, clip: { x: 0, y: plan[i].y, width: size.width, height: plan[i].height } });
                            files.push({ size: size.name, file, width: size.width, height: plan[i].height });
                        }
                    }
                    await ctx.close();
                }
            } finally {
                await browser?.close().catch(() => undefined);
            }

            if (opts.json) {
                log.json({ ok: true, kind: target.kind, pageId: target.pageId, url: target.url, pages, files });
                return;
            }
            log.info(`${target.kind === 'url' ? 'URL' : target.kind === 'live' ? 'Live page' : 'Draft'}: ${target.url}`);
            for (const pg of pages) {
                const n = files.filter((f) => f.size === pg.size).length;
                log.info(`${pg.size}: page ${pg.viewport}x${pg.height}, ${n} image${n === 1 ? '' : 's'}`);
                if (pg.noViewportMeta) log.warn(`${pg.size}: no <meta name="viewport">, so phones draw the page 980px wide and zoom it out.`);
                if (pg.overflowX) {
                    log.warn(`${pg.size}: the page is ${pg.scrollWidth}px wide on a ${pg.viewport}px screen, so it scrolls sideways.${pg.overflowing.length ? ` Sticking out: ${pg.overflowing.map((o) => safeText(o)).join(', ')}` : ''}`);
                }
            }
            for (const f of files) log.info(`${f.file}  (${f.size}, ${f.width}x${f.height})`);
        });
}
