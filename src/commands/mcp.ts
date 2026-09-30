import * as readline from 'readline';
import { Command } from 'commander';
import { ApiClient } from '../api/client';
import { EfRuntime, loadRuntime } from '../utils/store';
import { resolveProduct } from './productCommands';
import { BonusRule } from '../models/product';
import { EditableBonus, buildRule, normalizeBonuses, parseBonusSpec, toBonusPayload } from '../utils/bonuses';

/**
 * `ef mcp` — expose the bound brand to a desktop AI app over stdio MCP.
 *
 * Why this exists: Claude Desktop and ChatGPT Desktop cannot run shell commands
 * or touch the filesystem, so the "install the CLI and let the agent do it"
 * setup does not apply to them. MCP is the only way in, and it is spoken over
 * stdin/stdout by a process the desktop app spawns.
 *
 * The important property is where the credential lives. The desktop app's
 * config file only names a folder:
 *
 *   { "mcpServers": { "elasticfunnels": {
 *       "command": "ef", "args": ["mcp", "--project", "/path/to/project"] } } }
 *
 * The token is read from that folder's `.ef/auth` (chmod 600), so the config
 * file — which users sync, screenshot and paste into support threads — contains
 * no secret at all.
 *
 * Protocol notes: MCP over stdio is newline-delimited JSON-RPC 2.0. Every byte
 * on stdout is protocol, so ALL diagnostics must go to stderr — a stray
 * console.log corrupts the stream and the app reports an opaque failure.
 */

/** The MCP revision we implement. Echoed back in `initialize`. */
const PROTOCOL_VERSION = '2024-11-05';

interface JsonRpcRequest {
    jsonrpc: '2.0';
    id?: number | string | null;
    method: string;
    params?: any;
}

interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    /** Returns whatever should be shown to the model as text. */
    run: (args: any, ctx: { api: ApiClient; rt: EfRuntime }) => Promise<unknown>;
}

/** Everything that is not protocol goes here, never to stdout. */
function debug(message: string): void {
    process.stderr.write(`[ef mcp] ${message}\n`);
}

const TOOLS: ToolDefinition[] = [
    {
        name: 'ef_list_pages',
        description:
            'List the pages in this ElasticFunnels brand (id, title, slug, status). Start here to find the page id or slug for the other tools.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        run: async (_args, { api, rt }) => {
            const pages = await api.listPages(rt.config.brandId);
            return pages.map((p: any) => ({
                id: p.id,
                title: p.title,
                slug: p.slug,
                variant_slug: p.variant_slug ?? null,
                status: p.status ?? null,
                updated_at: p.updated_at ?? null,
            }));
        },
    },
    {
        name: 'ef_get_page',
        description:
            'Get one page\'s HTML/template body. Pass the numeric page id from ef_list_pages. Set published=true for the live version instead of the current draft.',
        inputSchema: {
            type: 'object',
            properties: {
                page_id: { type: 'number', description: 'Numeric page id from ef_list_pages.' },
                published: { type: 'boolean', description: 'Fetch the published version rather than the draft.' },
            },
            required: ['page_id'],
            additionalProperties: false,
        },
        run: async (args, { api, rt }) => {
            const page: any = await api.getPageContent(rt.config.brandId, Number(args.page_id), {
                published: !!args.published,
            });
            return {
                id: page.id,
                title: page.title,
                slug: page.slug,
                revision_id: page.revision_id ?? null,
                html: page.html ?? page.content ?? '',
            };
        },
    },
    {
        name: 'ef_update_page_html',
        description:
            'Replace a page\'s HTML/template body. Publishes immediately unless draft=true. ALWAYS call ef_get_page first and edit what it returns — this overwrites the whole body.',
        inputSchema: {
            type: 'object',
            properties: {
                page_id: { type: 'number', description: 'Numeric page id.' },
                html: { type: 'string', description: 'The complete new body. Not a patch — it replaces everything.' },
                draft: { type: 'boolean', description: 'Save as a draft instead of publishing live.' },
            },
            required: ['page_id', 'html'],
            additionalProperties: false,
        },
        run: async (args, { api, rt }) => {
            const pageId = Number(args.page_id);
            const res: any = await api.updatePageHtml(rt.config.brandId, pageId, String(args.html), {
                draft: !!args.draft,
                autoCreateCollections: true,
            });
            // The server rewrites the HTML it was given — `COLLECTION_CODE`
            // placeholders become real codes, forms get an `action`. Returning
            // only a revision id left the model believing its own draft was
            // what shipped, so its next edit would re-send the placeholder and
            // undo the rewrite. Hand back what the page actually says now.
            const canonical = await api.getPageContent(rt.config.brandId, pageId).catch(() => null);
            return {
                ok: true,
                published: !args.draft,
                revision_id: canonical?.revision_id ?? res?.revision_id ?? null,
                collections_created: res?.collections_created ?? [],
                html: canonical?.html ?? null,
                note: canonical?.html
                    ? 'The server may have rewritten your HTML (collection codes, form actions). "html" is the saved version — use it as the base for your next edit.'
                    : undefined,
            };
        },
    },
    {
        name: 'ef_create_page',
        description: 'Create a new empty page in this brand. Returns its id and slug so you can fill it in with ef_update_page_html.',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Human-readable page title.' },
                slug: { type: 'string', description: 'URL slug. Derived from the title when omitted.' },
            },
            required: ['title'],
            additionalProperties: false,
        },
        run: async (args, { api, rt }) => {
            const page: any = await api.createPage(rt.config.brandId, String(args.title), args.slug ? String(args.slug) : undefined);
            return { id: page.id, title: page.title, slug: page.slug };
        },
    },
    {
        name: 'ef_list_components',
        description: 'List the brand\'s reusable components (id, code, name). Components are included in pages with @component("code").',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        run: async (_args, { api, rt }) => {
            const components = await api.listComponents(rt.config.brandId);
            return components.map((c: any) => ({ id: c.id, code: c.code, name: c.name }));
        },
    },
    {
        name: 'ef_get_component',
        description: 'Get one component\'s body by numeric component id (from ef_list_components).',
        inputSchema: {
            type: 'object',
            properties: {
                component_id: { type: 'number', description: 'Numeric component id.' },
                published: { type: 'boolean', description: 'Fetch the published version rather than the draft.' },
            },
            required: ['component_id'],
            additionalProperties: false,
        },
        run: async (args, { api, rt }) => {
            const component: any = await api.getComponentContent(rt.config.brandId, Number(args.component_id), {
                published: !!args.published,
            });
            return {
                id: component.id,
                code: component.code,
                name: component.name,
                html: component.html ?? component.content ?? '',
            };
        },
    },
    {
        name: 'ef_list_products',
        description: 'List the brand\'s products (id, code, title, price, classification, bonuses, bonus_rule). Product codes are what buy()/upsell() links reference. `bonuses` are free products attached to a main product; `bonus_rule` says how many the buyer picks (min_picks/max_picks, max null = all) and whether giftable bonuses can be sent to a friend.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        run: async (_args, { api, rt }) => {
            const products = await api.listProducts(rt.config.brandId);
            return products.map((p: any) => ({
                id: p.id,
                code: p.code,
                title: p.title,
                price: p.price ?? null,
                classification: p.classification ?? null,
                bonuses: Array.isArray(p.bonuses) && p.bonuses.length
                    ? normalizeBonuses(p.bonuses).map((b) => ({ code: b.code ?? null, product_id: b.product_id ?? null, quantity: b.quantity, giftable: b.giftable }))
                    : undefined,
                bonus_rule: p.bonus_rule ?? undefined,
            }));
        },
    },
    {
        name: 'ef_set_product_bonuses',
        description:
            'Set a main product\'s bonuses and/or its pick rule. A bonus is a FREE product (classification "bonus") attached to a main product or package; it is NOT an order bump — never fake bonuses as $0 bumps. '
            + '`bonuses` REPLACES the whole ordered list (order = position; when the buyer picks nothing they get the first N by position, or all). '
            + '`rule`: mode "pick" = exactly count, "up_to" = 1..count, "all" = every bonus, no picking; gift_shipping_enabled lets the buyer send the GIFTABLE bonuses to a friend (a separate linked gift order; friend email optional, never notified); gift_shipping_mode same_as_main (default) | free | fixed (+ gift_shipping_price), charged on the main order. rule: null deletes the rule. '
            + 'Without a rule the internal checkout ignores the product\'s bonuses. For a seasonal offer that must not change the normal checkout, use checkout_settings.bonuses in the page backend script instead.',
        inputSchema: {
            type: 'object',
            properties: {
                product: { type: 'string', description: 'Main product id or code.' },
                bonuses: {
                    type: 'array',
                    description: 'Full ordered list of bonuses (replaces the current list). [] removes all. Omit to leave the list unchanged.',
                    items: {
                        type: 'object',
                        properties: {
                            code: { type: 'string', description: 'Bonus product code (classification bonus).' },
                            quantity: { type: 'number', description: 'Units of this bonus (default 1).' },
                            giftable: { type: 'boolean', description: 'May be sent to a friend (default false).' },
                        },
                        required: ['code'],
                        additionalProperties: false,
                    },
                },
                rule: {
                    type: ['object', 'null'],
                    description: 'Pick rule. null deletes it. Omit to leave it unchanged. Partial objects merge into the current rule.',
                    properties: {
                        mode: { type: 'string', enum: ['pick', 'up_to', 'all'] },
                        count: { type: 'number', description: 'n for pick / up_to. Must not exceed the number of bonuses.' },
                        default_mode: { type: 'string', enum: ['first_n', 'all'], description: 'What the order gets when nothing is picked.' },
                        gift_shipping_enabled: { type: 'boolean' },
                        gift_shipping_mode: { type: 'string', enum: ['same_as_main', 'free', 'fixed'] },
                        gift_shipping_price: { type: 'number', description: 'Required when gift_shipping_mode is fixed.' },
                    },
                    additionalProperties: false,
                },
            },
            required: ['product'],
            additionalProperties: false,
        },
        run: async (args, { api, rt }) => {
            const product = await resolveProduct(api, rt.config.brandId, String(args.product));
            let list: EditableBonus[] = normalizeBonuses(product.bonuses);
            const payload: Record<string, unknown> = {};
            if (Array.isArray(args.bonuses)) {
                const seen = new Set<string>();
                list = args.bonuses.map((b: any) => {
                    const spec = parseBonusSpec(String(b?.code ?? ''));
                    const key = spec.code.toLowerCase();
                    if (seen.has(key)) throw new Error(`"${spec.code}" is listed twice.`);
                    seen.add(key);
                    return { code: spec.code, quantity: b.quantity != null ? Number(b.quantity) : 1, giftable: !!b.giftable };
                });
                payload.bonuses = toBonusPayload(list);
            }
            const warnings: string[] = [];
            if (args.rule === null) {
                payload.bonus_rule = null;
            } else if (args.rule && typeof args.rule === 'object') {
                const r = args.rule;
                const built = buildRule(product.bonus_rule as BonusRule | null, {
                    pick: r.mode === 'pick' ? Number(r.count) : undefined,
                    upTo: r.mode === 'up_to' ? Number(r.count) : undefined,
                    all: r.mode === 'all',
                    default: r.default_mode,
                    gift: r.gift_shipping_enabled == null ? undefined : (r.gift_shipping_enabled ? 'on' : 'off'),
                    giftShipping: r.gift_shipping_mode,
                    giftPrice: r.gift_shipping_price == null ? undefined : Number(r.gift_shipping_price),
                }, list.length, list.filter((b) => b.giftable).length);
                payload.bonus_rule = built.rule;
                warnings.push(...built.warnings);
            } else if (payload.bonuses) {
                const rule = product.bonus_rule;
                if (rule && rule.max_picks != null && rule.max_picks > list.length) {
                    throw new Error(`The current rule lets the buyer pick ${rule.max_picks} but only ${list.length} bonuses would remain. Send a new rule too.`);
                }
            }
            if (!Object.keys(payload).length) throw new Error('Pass bonuses, rule, or both.');
            if (product.title) payload.title = product.title;
            const updated: any = await api.updateProduct(rt.config.brandId, product.id, payload);
            return {
                ok: true,
                product: { id: updated.id ?? product.id, code: updated.code ?? product.code },
                bonuses: updated.bonuses ?? payload.bonuses ?? product.bonuses ?? [],
                bonus_rule: updated.bonus_rule !== undefined ? updated.bonus_rule : (payload.bonus_rule !== undefined ? payload.bonus_rule : product.bonus_rule ?? null),
                warnings: warnings.length ? warnings : undefined,
            };
        },
    },
    {
        name: 'ef_preview_url',
        description: 'Get the editor preview URL for a page, so the user can look at it in a browser.',
        inputSchema: {
            type: 'object',
            properties: { page_id: { type: 'number', description: 'Numeric page id.' } },
            required: ['page_id'],
            additionalProperties: false,
        },
        run: async (args, { api, rt }) => ({ url: await api.getPreviewUrl(rt.config.brandId, Number(args.page_id)) }),
    },
];

/**
 * Serve MCP on stdin/stdout until the stream closes.
 *
 * The runtime is resolved lazily, on the first request that needs it: a desktop
 * app spawns this process at launch and keeps it alive, so failing at startup
 * because the folder is not bound yet would just look like "the connector is
 * broken" with no way to see why. Failing per-call surfaces the real message.
 */
export async function serveMcp(opts: { project?: string }): Promise<void> {
    let ctx: { api: ApiClient; rt: EfRuntime } | null = null;

    const context = async () => {
        if (!ctx) {
            const rt = await loadRuntime(opts.project ? { startDir: opts.project } : undefined);
            ctx = { api: new ApiClient(rt.config.apiUrl, rt.apiKey), rt };
            debug(`bound to brand #${rt.config.brandId} at ${rt.projectRoot}`);
        }
        return ctx;
    };

    const send = (message: unknown) => {
        process.stdout.write(JSON.stringify(message) + '\n');
    };

    const reply = (id: JsonRpcRequest['id'], result: unknown) => send({ jsonrpc: '2.0', id, result });

    const replyError = (id: JsonRpcRequest['id'], code: number, message: string) =>
        send({ jsonrpc: '2.0', id, error: { code, message } });

    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

    for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let req: JsonRpcRequest;
        try {
            req = JSON.parse(trimmed);
        } catch {
            debug(`ignoring unparseable line: ${trimmed.slice(0, 120)}`);
            continue;
        }

        // Notifications carry no id and MUST NOT be answered.
        const isNotification = req.id === undefined || req.id === null;

        try {
            switch (req.method) {
                case 'initialize':
                    reply(req.id, {
                        protocolVersion: PROTOCOL_VERSION,
                        capabilities: { tools: {} },
                        serverInfo: { name: 'elasticfunnels', version: cliVersion() },
                    });
                    break;

                case 'notifications/initialized':
                case 'initialized':
                    break; // handshake complete, nothing to answer

                case 'ping':
                    if (!isNotification) reply(req.id, {});
                    break;

                case 'tools/list':
                    reply(req.id, {
                        tools: TOOLS.map((t) => ({
                            name: t.name,
                            description: t.description,
                            inputSchema: t.inputSchema,
                        })),
                    });
                    break;

                case 'tools/call': {
                    const name = req.params?.name;
                    const tool = TOOLS.find((t) => t.name === name);

                    if (!tool) {
                        replyError(req.id, -32602, `Unknown tool: ${name}`);
                        break;
                    }

                    try {
                        const result = await tool.run(req.params?.arguments ?? {}, await context());
                        reply(req.id, {
                            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                        });
                    } catch (err) {
                        // A failed tool is reported as a RESULT with isError, not a
                        // JSON-RPC error: the model should see what went wrong and be
                        // able to correct itself, rather than the app treating the
                        // whole connector as broken.
                        const message = err instanceof Error ? err.message : String(err);
                        debug(`tool ${name} failed: ${message}`);
                        reply(req.id, {
                            content: [{ type: 'text', text: `Error: ${message}` }],
                            isError: true,
                        });
                    }
                    break;
                }

                default:
                    if (!isNotification) replyError(req.id, -32601, `Method not found: ${req.method}`);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            debug(`request ${req.method} failed: ${message}`);
            if (!isNotification) replyError(req.id, -32603, message);
        }
    }
}

function cliVersion(): string {
    try {
        return require('../../package.json').version as string;
    } catch {
        return '0.0.0';
    }
}

export function registerMcpCommand(program: Command): void {
    program
        .command('mcp')
        .description('Serve this brand to a desktop AI app (Claude Desktop, ChatGPT Desktop) over stdio MCP. Reads credentials from the project folder, so the app\'s config file holds no secret.')
        .option('--project <dir>', 'Project folder to serve. Defaults to walking up from the current directory, like every other command.')
        .action(async (opts: { project?: string }) => {
            debug(`starting (protocol ${PROTOCOL_VERSION}, ${TOOLS.length} tools)`);
            await serveMcp(opts);
        });
}
