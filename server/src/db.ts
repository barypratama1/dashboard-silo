import Database from "better-sqlite3";
import { DuckDBInstance } from "@duckdb/node-api";
import { mkdirSync } from "node:fs";

mkdirSync("data/uploads", { recursive: true });

// Metadata store (users, datasources). Postgres can replace this later.
export const meta = new Database("data/meta.db");
meta.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS datasources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  table_name TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);
// Migration: calculated fields were added after the first release.
try {
  meta.exec("ALTER TABLE datasources ADD COLUMN calcs_json TEXT NOT NULL DEFAULT '[]'");
} catch {
  /* column already exists */
}

// Analytical engine for uploaded files.
const instance = await DuckDBInstance.create("data/extracts.duckdb");
export const duck = await instance.connect();

export async function query(sql: string) {
  const reader = await duck.runAndReadAll(sql);
  return reader.getRowObjectsJson() as Record<string, unknown>[];
}

const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UBIGINT|UINTEGER|FLOAT|DOUBLE|DECIMAL)/;
const DATE = /^(DATE|TIMESTAMP)/;

export interface Field {
  name: string;
  type: string;
  role: "dimension" | "measure";
  kind: "number" | "date" | "string" | "boolean";
  calc?: boolean;
  expression?: string;
}

export function classify(name: string, type: string): Field {
  if (NUMERIC.test(type)) return { name, type, role: "measure", kind: "number" };
  if (DATE.test(type)) return { name, type, role: "dimension", kind: "date" };
  if (type === "BOOLEAN") return { name, type, role: "dimension", kind: "boolean" };
  return { name, type, role: "dimension", kind: "string" };
}

export const quoteId = (s: string) => `"${s.replace(/"/g, '""')}"`;

// getRowObjectsJson serializes BIGINT/HUGEINT/DECIMAL as strings; convert numeric columns back to numbers.
export function coerceNumbers(rows: Record<string, unknown>[], fields: Field[]) {
  const numeric = fields.filter((f) => f.kind === "number").map((f) => f.name);
  for (const r of rows) {
    for (const n of numeric) {
      if (typeof r[n] === "string") r[n] = Number(r[n]);
    }
  }
  return rows;
}
