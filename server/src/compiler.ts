import { quoteId, type Field } from "./db.js";

export const AGGS = ["sum", "avg", "count", "min", "max", "none"] as const;
export type Agg = (typeof AGGS)[number];
export const TRUNCS = ["year", "quarter", "month", "week", "day"] as const;
export type Trunc = (typeof TRUNCS)[number];
export const MARKS = ["auto", "bar", "line", "area", "scatter", "pie", "heatmap", "treemap"] as const;

export interface ShelfField {
  field: string;
  agg?: Agg; // measures only
  trunc?: Trunc; // date dimensions only
}

/**
 * Row-level filter, applied before aggregation. Which properties matter depends on the field:
 * dimensions use `values`, numeric fields use `min`/`max`, date fields use `from`/`to` (YYYY-MM-DD).
 * An undefined bound means unrestricted; an empty `values` array matches nothing.
 */
export interface FilterSpec {
  field: string;
  values?: string[];
  min?: number | null;
  max?: number | null;
  from?: string | null;
  to?: string | null;
}

/** Declarative description of one visualization (the VizQL equivalent). */
export interface VizSpec {
  mark: (typeof MARKS)[number];
  columns: ShelfField[];
  rows: ShelfField[];
  color?: ShelfField | null;
  filters?: FilterSpec[];
}

const sqlStr = (s: string) => `'${String(s).replace(/'/g, "''")}'`;

export function buildWhere(filters: FilterSpec[] | undefined, byName: Map<string, Field>): string {
  const parts: string[] = [];
  for (const f of filters ?? []) {
    const meta = byName.get(f.field);
    if (!meta) throw new Error(`Field filter tidak dikenal: ${f.field}`);
    const col = quoteId(f.field);
    if (meta.role === "measure") {
      if (f.min != null) {
        if (!Number.isFinite(Number(f.min))) throw new Error("Nilai min filter tidak valid");
        parts.push(`${col} >= ${Number(f.min)}`);
      }
      if (f.max != null) {
        if (!Number.isFinite(Number(f.max))) throw new Error("Nilai max filter tidak valid");
        parts.push(`${col} <= ${Number(f.max)}`);
      }
    } else if (meta.kind === "date") {
      const ok = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
      if (f.from) {
        if (!ok(f.from)) throw new Error("Tanggal 'from' harus berformat YYYY-MM-DD");
        parts.push(`CAST(${col} AS DATE) >= DATE ${sqlStr(f.from)}`);
      }
      if (f.to) {
        if (!ok(f.to)) throw new Error("Tanggal 'to' harus berformat YYYY-MM-DD");
        parts.push(`CAST(${col} AS DATE) <= DATE ${sqlStr(f.to)}`);
      }
    } else if (f.values) {
      if (!Array.isArray(f.values)) throw new Error("values filter harus berupa array");
      parts.push(f.values.length ? `CAST(${col} AS VARCHAR) IN (${f.values.map(sqlStr).join(", ")})` : "1 = 0");
    }
  }
  return parts.length ? ` WHERE ${parts.join(" AND ")}` : "";
}

/** Deterministic result-column alias for a shelf field. Mirrored in the frontend. */
export function fieldLabel(f: ShelfField, meta?: Field): string {
  if (meta?.role === "measure") {
    const agg = f.agg ?? "sum";
    return agg === "none" ? f.field : `${agg.toUpperCase()}(${f.field})`;
  }
  if (meta?.kind === "date" && f.trunc) return `${f.trunc.toUpperCase()}(${f.field})`;
  return f.field;
}

export interface Compiled {
  sql: string;
  labels: { columns: string[]; rows: string[]; color: string | null };
  measureLabels: string[];
}

const MAX_ROWS = 5000;

export function compile(spec: VizSpec, source: string, fields: Field[]): Compiled {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const select = new Map<string, string>(); // alias -> expression
  const groupBy: string[] = [];
  const dimAliases: string[] = [];
  const measureLabels: string[] = [];
  let rawMode = false;

  const resolve = (sf: ShelfField) => {
    const meta = byName.get(sf.field);
    if (!meta) throw new Error(`Field tidak dikenal: ${sf.field}`);
    if (sf.agg && !AGGS.includes(sf.agg)) throw new Error(`Agregasi tidak valid: ${sf.agg}`);
    if (sf.trunc && !TRUNCS.includes(sf.trunc)) throw new Error(`Trunc tidak valid: ${sf.trunc}`);
    return meta;
  };

  const add = (sf: ShelfField): string => {
    const meta = resolve(sf);
    const label = fieldLabel(sf, meta);
    const col = quoteId(sf.field);
    let expr: string;
    if (meta.role === "measure") {
      if (!measureLabels.includes(label)) measureLabels.push(label);
      const agg = sf.agg ?? "sum";
      if (agg === "none") {
        rawMode = true;
        expr = col;
      } else if (agg === "count") {
        expr = `COUNT(${col})`;
      } else {
        expr = `${agg.toUpperCase()}(${col})`;
      }
    } else {
      expr = meta.kind === "date" && sf.trunc ? `date_trunc('${sf.trunc}', ${col})` : col;
      if (!dimAliases.includes(label)) dimAliases.push(label);
      if (!groupBy.includes(expr)) groupBy.push(expr);
    }
    select.set(quoteId(label), expr);
    return label;
  };

  const labels = {
    columns: spec.columns.map(add),
    rows: spec.rows.map(add),
    color: spec.color ? add(spec.color) : null,
  };

  if (select.size === 0) throw new Error("Spec kosong: tambahkan field ke shelf");

  const selectSql = [...select].map(([alias, expr]) => `${expr} AS ${alias}`).join(", ");
  let sql = `SELECT ${selectSql} FROM ${source}${buildWhere(spec.filters, byName)}`;
  if (rawMode) {
    // Disaggregated: every measure on the shelves must be raw, otherwise SQL grouping would be ambiguous.
    const mixed = [...select.values()].some((e) => /^(SUM|AVG|COUNT|MIN|MAX)\(/.test(e));
    if (mixed) throw new Error("Tidak bisa mencampur agregasi dan 'none' dalam satu visualisasi");
  } else if (groupBy.length) {
    sql += ` GROUP BY ${groupBy.join(", ")} ORDER BY ${groupBy.join(", ")}`;
  }
  sql += ` LIMIT ${MAX_ROWS}`;
  return { sql, labels, measureLabels };
}
