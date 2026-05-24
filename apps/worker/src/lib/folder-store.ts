/**
 * Folder CRUD for the dealer asset portal.
 *
 * §4.4: max 3 levels deep — root = depth 0, sub = 1, sub-sub = 2. We reject
 * any insert that would push depth above 2. The depth column is also
 * CHECK-constrained at the schema layer (`CHECK (depth <= 2)`); this is the
 * application-level fence so we can give a clean error rather than letting
 * D1 throw.
 */

export type FolderVisibilityMode = 'all_b2b' | 'tiers' | 'companies';

const VISIBILITY_MODES: ReadonlyArray<FolderVisibilityMode> = [
  'all_b2b',
  'tiers',
  'companies',
];

export class FolderValidationError extends Error {}

export interface FolderInput {
  parent_id: number | null;
  name: string;
  visibility_mode: FolderVisibilityMode;
}

export interface Folder {
  id: number;
  shop_id: number;
  parent_id: number | null;
  name: string;
  visibility_mode: FolderVisibilityMode;
  depth: number;
  created_at: number;
  deleted_at: number | null;
}

export function validateFolderInput(input: unknown): FolderInput {
  if (typeof input !== 'object' || input === null) {
    throw new FolderValidationError('folder payload must be an object');
  }
  const f = input as Record<string, unknown>;

  if (typeof f.name !== 'string' || f.name.trim().length === 0 || f.name.length > 100) {
    throw new FolderValidationError('name must be 1-100 chars');
  }
  if (
    typeof f.visibility_mode !== 'string' ||
    !(VISIBILITY_MODES as readonly string[]).includes(f.visibility_mode)
  ) {
    throw new FolderValidationError(
      `visibility_mode must be one of ${VISIBILITY_MODES.join(', ')}`,
    );
  }
  const parent = f.parent_id;
  if (parent !== null && parent !== undefined) {
    if (!Number.isInteger(parent) || (parent as number) <= 0) {
      throw new FolderValidationError('parent_id must be a positive integer or null');
    }
  }
  return {
    parent_id: (parent as number | null | undefined) ?? null,
    name: (f.name as string).trim(),
    visibility_mode: f.visibility_mode as FolderVisibilityMode,
  };
}

function rowToFolder(row: Record<string, unknown>): Folder {
  return {
    id: row.id as number,
    shop_id: row.shop_id as number,
    parent_id: (row.parent_id as number | null) ?? null,
    name: row.name as string,
    visibility_mode: row.visibility_mode as FolderVisibilityMode,
    depth: row.depth as number,
    created_at: row.created_at as number,
    deleted_at: (row.deleted_at as number | null) ?? null,
  };
}

export async function listFolders(db: D1Database, shopId: number): Promise<Folder[]> {
  const result = await db
    .prepare(
      `SELECT id, shop_id, parent_id, name, visibility_mode, depth, created_at, deleted_at
       FROM asset_folders
       WHERE shop_id = ? AND deleted_at IS NULL
       ORDER BY depth ASC, name ASC`,
    )
    .bind(shopId)
    .all<Record<string, unknown>>();
  return (result.results ?? []).map(rowToFolder);
}

export async function getFolder(
  db: D1Database,
  shopId: number,
  folderId: number,
): Promise<Folder | null> {
  const row = await db
    .prepare(
      `SELECT id, shop_id, parent_id, name, visibility_mode, depth, created_at, deleted_at
       FROM asset_folders
       WHERE shop_id = ? AND id = ?`,
    )
    .bind(shopId, folderId)
    .first<Record<string, unknown>>();
  return row ? rowToFolder(row) : null;
}

export async function createFolder(
  db: D1Database,
  shopId: number,
  input: FolderInput,
): Promise<Folder> {
  let depth = 0;
  if (input.parent_id !== null) {
    const parent = await getFolder(db, shopId, input.parent_id);
    if (!parent || parent.deleted_at !== null) {
      throw new FolderValidationError('parent folder not found');
    }
    depth = parent.depth + 1;
    if (depth > 2) {
      throw new FolderValidationError('folders cannot nest more than 3 levels deep');
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const result = await db
    .prepare(
      `INSERT INTO asset_folders
         (shop_id, parent_id, name, visibility_mode, depth, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .bind(shopId, input.parent_id, input.name, input.visibility_mode, depth, now)
    .first<{ id: number }>();

  if (!result) throw new Error('createFolder: no row returned');
  return {
    id: result.id,
    shop_id: shopId,
    parent_id: input.parent_id,
    name: input.name,
    visibility_mode: input.visibility_mode,
    depth,
    created_at: now,
    deleted_at: null,
  };
}

export async function renameFolder(
  db: D1Database,
  shopId: number,
  folderId: number,
  name: string,
  visibilityMode: FolderVisibilityMode,
): Promise<Folder | null> {
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 100) {
    throw new FolderValidationError('name must be 1-100 chars');
  }
  if (!(VISIBILITY_MODES as readonly string[]).includes(visibilityMode)) {
    throw new FolderValidationError(
      `visibility_mode must be one of ${VISIBILITY_MODES.join(', ')}`,
    );
  }
  const res = await db
    .prepare(
      `UPDATE asset_folders
         SET name = ?, visibility_mode = ?
       WHERE shop_id = ? AND id = ? AND deleted_at IS NULL`,
    )
    .bind(name.trim(), visibilityMode, shopId, folderId)
    .run();
  if ((res.meta?.changes ?? 0) === 0) return null;
  return getFolder(db, shopId, folderId);
}

/**
 * Soft delete — children and asset rows keep their parent_id / folder_id
 * (FK stays valid), but reads filter by deleted_at IS NULL. The admin can
 * later "empty" a deleted folder by hard-deleting its descendants in a
 * follow-up pass; v1 we leave them dangling so undo is easy.
 */
export async function softDeleteFolder(
  db: D1Database,
  shopId: number,
  folderId: number,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const res = await db
    .prepare(
      `UPDATE asset_folders SET deleted_at = ?
       WHERE shop_id = ? AND id = ? AND deleted_at IS NULL`,
    )
    .bind(now, shopId, folderId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}
