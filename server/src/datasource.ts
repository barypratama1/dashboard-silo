import { meta, quoteId, type Field } from "./db.js";
import { exprToSql } from "./expr.js";

export interface CalcDef {
  name: string;
  expression: string;
  type: string;
}

export interface LoadedDatasource {
  id: number;
  table: string;
  baseFields: Field[];
  calcs: CalcDef[];
  /** Base columns followed by calculated fields. */
  fields: Field[];
  /** SQL fragment usable after FROM: the raw table, wrapped once per calculated field. */
  source: string;
}

/**
 * Each calculated field is a layer: SELECT *, (expr) AS "name" FROM <previous layer>.
 * A calc may therefore reference base fields and any calc defined before it.
 */
export function buildSource(table: string, baseFields: Field[], calcs: CalcDef[]): string {
  let src = quoteId(table);
  const avail: Field[] = [...baseFields];
  for (const c of calcs) {
    src = `(SELECT *, (${exprToSql(c.expression, avail)}) AS ${quoteId(c.name)} FROM ${src})`;
    avail.push({ name: c.name, type: c.type, role: "dimension", kind: "string" });
  }
  return src;
}

export function calcToField(c: CalcDef, classify: (n: string, t: string) => Field): Field {
  return { ...classify(c.name, c.type), calc: true, expression: c.expression };
}

export function loadDatasource(
  id: number | string,
  userId: number,
  classify: (n: string, t: string) => Field,
): LoadedDatasource | null {
  const row = meta
    .prepare("SELECT id, table_name, schema_json, calcs_json FROM datasources WHERE id = ? AND user_id = ?")
    .get(id, userId) as any;
  if (!row) return null;
  const baseFields: Field[] = JSON.parse(row.schema_json);
  const calcs: CalcDef[] = JSON.parse(row.calcs_json ?? "[]");
  return {
    id: row.id,
    table: row.table_name,
    baseFields,
    calcs,
    fields: [...baseFields, ...calcs.map((c) => calcToField(c, classify))],
    source: buildSource(row.table_name, baseFields, calcs),
  };
}
