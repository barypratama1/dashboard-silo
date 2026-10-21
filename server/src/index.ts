import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import bcrypt from "bcryptjs";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { meta, query, classify, quoteId, coerceNumbers, type Field } from "./db.js";
import { compile, type VizSpec } from "./compiler.js";
import { loadDatasource, buildSource, calcToField, type CalcDef } from "./datasource.js";
import { exprToSql, SUPPORTED_FUNCTIONS } from "./expr.js";

const app = Fastify({ logger: true });
/** DuckDB errors append the failing SQL after the first line; only the first line is safe to show. */
const firstLine = (m: string) => String(m).split("\n")[0];
await app.register(cors, { origin: true });
await app.register(jwt, { secret: process.env.JWT_SECRET ?? "dev-secret-change-me" });
await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } });

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { id: number; email: string };
    user: { id: number; email: string };
  }
}

const auth = async (req: any, reply: any) => {
  try {
    await req.jwtVerify();
  } catch {
    reply.code(401).send({ error: "Unauthorized" });
  }
};

// ---------- Auth ----------
app.post<{ Body: { email: string; password: string } }>("/api/auth/register", async (req, reply) => {
  const { email, password } = req.body ?? ({} as any);
  if (!email || !password || password.length < 6)
    return reply.code(400).send({ error: "Email dan password (min 6 karakter) wajib diisi" });
  try {
    const info = meta
      .prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)")
      .run(email.toLowerCase(), bcrypt.hashSync(password, 10));
    const id = Number(info.lastInsertRowid);
    return { token: app.jwt.sign({ id, email }), user: { id, email } };
  } catch {
    return reply.code(409).send({ error: "Email sudah terdaftar" });
  }
});

app.post<{ Body: { email: string; password: string } }>("/api/auth/login", async (req, reply) => {
  const { email, password } = req.body ?? ({} as any);
  const row = meta.prepare("SELECT * FROM users WHERE email = ?").get(String(email).toLowerCase()) as any;
  if (!row || !bcrypt.compareSync(String(password), row.password_hash))
    return reply.code(401).send({ error: "Email atau password salah" });
  return { token: app.jwt.sign({ id: row.id, email: row.email }), user: { id: row.id, email: row.email } };
});

// ---------- Datasources ----------
app.get("/api/datasources", { preHandler: auth }, async (req) => {
  const rows = meta
    .prepare("SELECT id, name, created_at FROM datasources WHERE user_id = ? ORDER BY id DESC")
    .all(req.user.id) as any[];
  return rows.map((r) => {
    const ds = loadDatasource(r.id, req.user.id, classify)!;
    return { id: r.id, name: r.name, createdAt: r.created_at, fields: ds.fields };
  });
});

app.post("/api/datasources/upload", { preHandler: auth }, async (req, reply) => {
  const file = await req.file();
  if (!file) return reply.code(400).send({ error: "File tidak ditemukan" });
  const ext = file.filename.split(".").pop()?.toLowerCase();
  if (ext !== "csv") return reply.code(400).send({ error: "Saat ini hanya CSV yang didukung" });

  const path = resolve("data/uploads", `${randomUUID()}.csv`);
  await pipeline(file.file, createWriteStream(path));

  const table = `ds_${randomUUID().replace(/-/g, "")}`;
  const escaped = path.replace(/'/g, "''");
  try {
    await query(`CREATE TABLE ${table} AS SELECT * FROM read_csv_auto('${escaped}', header=true)`);
  } catch (e: any) {
    return reply.code(400).send({ error: `CSV tidak valid: ${e.message}` });
  }
  const cols = await query(`DESCRIBE ${table}`);
  const fields: Field[] = cols.map((c) => classify(String(c.column_name), String(c.column_type)));
  const info = meta
    .prepare("INSERT INTO datasources (user_id, name, table_name, schema_json) VALUES (?, ?, ?, ?)")
    .run(req.user.id, file.filename, table, JSON.stringify(fields));
  const [{ n }] = (await query(`SELECT COUNT(*) AS n FROM ${table}`)) as any[];
  return { id: Number(info.lastInsertRowid), name: file.filename, rows: Number(n), fields };
});

app.get<{ Params: { id: string } }>("/api/datasources/:id/preview", { preHandler: auth }, async (req, reply) => {
  const ds = loadDatasource(req.params.id, req.user.id, classify);
  if (!ds) return reply.code(404).send({ error: "Datasource tidak ditemukan" });
  const rows = await query(`SELECT * FROM ${ds.source} LIMIT 100`);
  return coerceNumbers(rows, ds.fields);
});

// Distinct values (dimensions) or min/max (numbers, dates): drives the filter editor.
app.get<{ Params: { id: string }; Querystring: { field: string } }>(
  "/api/datasources/:id/field-stats",
  { preHandler: auth },
  async (req, reply) => {
    const ds = loadDatasource(req.params.id, req.user.id, classify);
    if (!ds) return reply.code(404).send({ error: "Datasource tidak ditemukan" });
    const f = ds.fields.find((x) => x.name === req.query.field);
    if (!f) return reply.code(400).send({ error: "Field tidak dikenal" });
    const col = quoteId(f.name);
    if (f.role === "measure" || f.kind === "date") {
      const [r] = await query(`SELECT CAST(MIN(${col}) AS VARCHAR) AS min, CAST(MAX(${col}) AS VARCHAR) AS max FROM ${ds.source}`);
      return f.role === "measure" ? { kind: "number", min: Number(r.min), max: Number(r.max) } : { kind: "date", min: r.min, max: r.max };
    }
    const limit = 500;
    const vals = await query(
      `SELECT DISTINCT CAST(${col} AS VARCHAR) AS v FROM ${ds.source} WHERE ${col} IS NOT NULL ORDER BY 1 LIMIT ${limit + 1}`,
    );
    return { kind: "values", values: vals.slice(0, limit).map((r) => r.v), truncated: vals.length > limit };
  },
);

// ---------- Calculated fields ----------
app.get("/api/expression-functions", { preHandler: auth }, async () => SUPPORTED_FUNCTIONS);

app.post<{ Params: { id: string }; Body: { name: string; expression: string } }>(
  "/api/datasources/:id/calcs",
  { preHandler: auth },
  async (req, reply) => {
    const ds = loadDatasource(req.params.id, req.user.id, classify);
    if (!ds) return reply.code(404).send({ error: "Datasource tidak ditemukan" });
    const name = String(req.body?.name ?? "").trim();
    const expression = String(req.body?.expression ?? "").trim();
    if (!name || name.length > 64) return reply.code(400).send({ error: "Nama wajib diisi (maks 64 karakter)" });
    if (ds.fields.some((f) => f.name.toLowerCase() === name.toLowerCase()))
      return reply.code(409).send({ error: `Nama '${name}' sudah dipakai oleh field lain` });
    try {
      // Parse (syntax/field/function checks) then let DuckDB bind it to learn the result type and catch type errors.
      const sqlExpr = exprToSql(expression, ds.fields);
      const probe = `SELECT (${sqlExpr}) AS v FROM ${ds.source} LIMIT 1`;
      const [col] = await query(`DESCRIBE ${probe}`);
      await query(probe);
      const def: CalcDef = { name, expression, type: String(col.column_type) };
      const calcs = [...ds.calcs, def];
      buildSource(ds.table, ds.baseFields, calcs); // sanity check
      meta.prepare("UPDATE datasources SET calcs_json = ? WHERE id = ?").run(JSON.stringify(calcs), ds.id);
      return { field: calcToField(def, classify) };
    } catch (e: any) {
      return reply.code(400).send({ error: firstLine(e.message) });
    }
  },
);

app.delete<{ Params: { id: string; name: string } }>("/api/datasources/:id/calcs/:name", { preHandler: auth }, async (req, reply) => {
  const ds = loadDatasource(req.params.id, req.user.id, classify);
  if (!ds) return reply.code(404).send({ error: "Datasource tidak ditemukan" });
  const idx = ds.calcs.findIndex((c) => c.name === req.params.name);
  if (idx < 0) return reply.code(404).send({ error: "Calculated field tidak ditemukan" });
  const calcs = ds.calcs.filter((_, i) => i !== idx);
  try {
    buildSource(ds.table, ds.baseFields, calcs); // later calcs must not depend on the removed one
  } catch {
    return reply.code(409).send({ error: "Field ini dipakai oleh calculated field lain" });
  }
  meta.prepare("UPDATE datasources SET calcs_json = ? WHERE id = ?").run(JSON.stringify(calcs), ds.id);
  return { ok: true };
});

app.post<{ Body: { datasourceId: number; spec: VizSpec } }>("/api/query", { preHandler: auth }, async (req, reply) => {
  const { datasourceId, spec } = req.body ?? ({} as any);
  const ds = loadDatasource(datasourceId, req.user.id, classify);
  if (!ds) return reply.code(404).send({ error: "Datasource tidak ditemukan" });
  try {
    const { sql, labels, measureLabels } = compile(spec, ds.source, ds.fields);
    const raw = await query(sql);
    // DuckDB JSON serializes BIGINT/DECIMAL aggregates as strings; restore numbers for measure columns only.
    const rows = raw.map((r) => {
      for (const k of measureLabels) if (typeof r[k] === "string") r[k] = Number(r[k]);
      return r;
    });
    return { rows, labels, sql };
  } catch (e: any) {
    return reply.code(400).send({ error: firstLine(e.message) });
  }
});

app.get("/api/health", async () => ({ ok: true }));

await app.listen({ port: Number(process.env.PORT ?? 4000), host: "0.0.0.0" });
