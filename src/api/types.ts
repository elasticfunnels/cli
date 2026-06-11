// Re-export DTOs from `src/models/*` — same layout as vscode-extension.
export type { Brand } from '../models/brand';
export type { Page, PageUpdateResponse } from '../models/page';
export type { Component } from '../models/component';
export type { PageFolder } from '../models/pageFolder';
export type { Asset, AssetEditorPayload } from '../models/asset';
export {
    BINARY_EDITOR_STUB_LINE,
    needsLocalAssetFallback,
    assetEditorPayloadToBuffer,
} from '../models/asset';
export type { BackendScript } from '../models/backendScript';
export type { BrandTemplate, BrandTemplatePage } from '../models/template';
