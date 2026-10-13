export interface PageFolder {
    id: number;
    name: string;
    parent_id?: number | null;
    color?: string | null;
    order?: number | null;
    /** Pages directly in this folder (not counting subfolders). */
    pages_count?: number;
    /** The index endpoint returns a tree: roots with nested children. */
    children?: PageFolder[];
}
