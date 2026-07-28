// Shared helpers for Drawflow graph JSON files (page events + funnel builder).
import { sha256 } from '../utils/fs';

/** Order-independent JSON serialization → a graph's hash is stable regardless of
 *  key order (the server may reorder keys on save). */
export function canonical(v: unknown): string {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

export function graphHash(graph: unknown): string {
    return sha256(Buffer.from(canonical(graph), 'utf8'));
}

export interface GraphLintIssue { severity: 'error' | 'warning'; message: string; }

/**
 * OFFLINE structural lint of a Drawflow graph (valid shape only). Deliberately
 * does NOT check node types / connection rules — those live in the server's
 * node vocabulary + validator (the source of truth, always current). Use the
 * `validate` subcommand for that; this just catches broken edits offline.
 */
export function structuralLintGraph(parsed: unknown): GraphLintIssue[] {
    const issues: GraphLintIssue[] = [];
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return [{ severity: 'error', message: 'Graph must be a JSON object.' }];
    }
    const df = (parsed as Record<string, unknown>).drawflow;
    if (df === null || typeof df !== 'object') {
        return [{ severity: 'error', message: 'Missing "drawflow" object.' }];
    }
    const home = (df as Record<string, unknown>).Home;
    if (home === null || typeof home !== 'object') {
        return [{ severity: 'error', message: 'Missing "drawflow.Home".' }];
    }
    const data = (home as Record<string, unknown>).data;
    if (data === null || typeof data !== 'object') {
        issues.push({ severity: 'error', message: 'Missing "drawflow.Home.data" (node map).' });
    }
    return issues;
}
