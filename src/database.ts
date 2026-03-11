import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Possible database locations
const DB_PATHS = [
  // iCloud sync (most common)
  join(
    homedir(),
    "Library/Group Containers/9K33E3U3T4.net.shinyfrog.bear/Application Data/database.sqlite"
  ),
  // Local storage (no iCloud)
  join(
    homedir(),
    "Library/Containers/net.shinyfrog.bear/Data/Documents/Application Data/database.sqlite"
  )
];

export class DatabaseError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "DatabaseError";
  }
}

const findDatabasePath = (): string => {
  for (const path of DB_PATHS) {
    if (existsSync(path)) {
      return path;
    }
  }

  throw new DatabaseError(
    "Bear database not found. Make sure Bear is installed and has been opened at least once."
  );
};

let db: Database | null = null;

export const getDatabase = (): Database => {
  if (!db) {
    const dbPath = findDatabasePath();

    try {
      db = new Database(dbPath, { readonly: true });
    } catch (error) {
      throw new DatabaseError("Failed to open Bear database", error);
    }
  }

  return db;
};

export const closeDatabase = (): void => {
  if (db) {
    db.close();
    db = null;
  }
};
