import type { Database } from "bun:sqlite";
import { DatabaseError } from "./database.js";

// Core Data does not name its join tables after the entities they connect --
// it names them after the entity *numbers* it assigned when it generated the
// store. Bear's note entity is currently number 5 and its tag entity number
// 13, which is the only reason `Z_5TAGS(Z_5NOTES, Z_13TAGS)` is spelled that
// way. Adding or removing an entity in a future Bear release renumbers them,
// and every tag query in this server would start failing with
// "no such table: Z_5TAGS".
//
// So the numbers are looked up instead of hardcoded. Core Data records the
// mapping in Z_PRIMARYKEY (Z_ENT -> Z_NAME), which is present in every Core
// Data store, and the result is validated against the real schema before any
// query uses it.

export interface TagJoin {
  // The many-to-many join table between notes and tags.
  table: string;
  // Column in `table` holding ZSFNOTE.Z_PK.
  noteColumn: string;
  // Column in `table` holding ZSFNOTETAG.Z_PK.
  tagColumn: string;
}

const NOTE_ENTITY = "SFNote";
const TAG_ENTITY = "SFNoteTag";

const entityId = (db: Database, name: string): number => {
  const row = db
    .prepare("SELECT Z_ENT as id FROM Z_PRIMARYKEY WHERE Z_NAME = ?")
    .get(name) as { id: number } | undefined;

  if (!row) {
    throw new DatabaseError(
      `Unsupported Bear database schema: Core Data entity '${name}' is not listed in Z_PRIMARYKEY. ` +
        "This usually means the Bear version that wrote this database is not supported by this server."
    );
  }
  return row.id;
};

const tableColumns = (db: Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(column => column.name);

// Resolves the tag join table for this database, failing with a message that
// says exactly what is missing rather than letting a generic "Failed to search
// notes" surface later.
export const discoverTagJoin = (db: Database): TagJoin => {
  const noteEntity = entityId(db, NOTE_ENTITY);
  const tagEntity = entityId(db, TAG_ENTITY);

  const join: TagJoin = {
    table: `Z_${noteEntity}TAGS`,
    noteColumn: `Z_${noteEntity}NOTES`,
    tagColumn: `Z_${tagEntity}TAGS`,
  };

  const columns = tableColumns(db, join.table);
  if (columns.length === 0) {
    throw new DatabaseError(
      `Unsupported Bear database schema: expected the note/tag join table '${join.table}' ` +
        `(derived from Core Data entity ids ${NOTE_ENTITY}=${noteEntity}, ${TAG_ENTITY}=${tagEntity}), ` +
        "but no such table exists. Bear's schema has probably changed."
    );
  }

  const missing = [join.noteColumn, join.tagColumn].filter(column => !columns.includes(column));
  if (missing.length > 0) {
    throw new DatabaseError(
      `Unsupported Bear database schema: table '${join.table}' is missing the expected ` +
        `column(s) ${missing.join(", ")}. Found: ${columns.join(", ")}. ` +
        "Bear's schema has probably changed."
    );
  }

  return join;
};

// Discovery reads the same tables on every call, so cache it per Database
// handle. A WeakMap keeps a closed database from being retained.
const cache = new WeakMap<Database, TagJoin>();

export const tagJoin = (db: Database): TagJoin => {
  const cached = cache.get(db);
  if (cached) return cached;
  const discovered = discoverTagJoin(db);
  cache.set(db, discovered);
  return discovered;
};

// `JOIN <join table> nt ON <noteAlias>.Z_PK = nt.<note column>` for a query
// that starts from ZSFNOTE. The alias `nt` is the caller's handle on the tag
// side of the join.
export const joinTagsFromNote = (join: TagJoin, noteAlias: string): string =>
  `JOIN ${join.table} nt ON ${noteAlias}.Z_PK = nt.${join.noteColumn}`;
