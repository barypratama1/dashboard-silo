import { quoteId, type Field } from "./db.js";

/**
 * Calculated-field expression language (row-level), compiled to a DuckDB SQL expression.
 *
 *   [Sales] * (1 - [Discount])
 *   IF [Profit] > 0 THEN "Untung" ELSEIF [Profit] = 0 THEN "Impas" ELSE "Rugi" END
 *   YEAR([Order Date]) & ROUND([Sales] / [Quantity], 2)
 *
 * Only whitelisted functions and existing field references are emitted, so user input never reaches SQL verbatim.
 */

type TokType = "num" | "str" | "field" | "id" | "op" | "lp" | "rp" | "comma" | "eof";
interface Tok {
  t: TokType;
  v: string;
  pos: number;
}

const KEYWORDS = new Set(["IF", "THEN", "ELSEIF", "ELSE", "END", "AND", "OR", "NOT", "TRUE", "FALSE", "NULL"]);
const MAX_LEN = 1000;
const MAX_DEPTH = 40;
const DATE_PARTS = ["year", "quarter", "month", "week", "day", "hour", "minute", "second"];

function tokenize(src: string): Tok[] {
  if (src.length > MAX_LEN) throw new Error(`Ekspresi terlalu panjang (maks ${MAX_LEN} karakter)`);
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "[") {
      const end = src.indexOf("]", i);
      if (end < 0) throw new Error(`Tanda ] tidak ditemukan untuk [ pada posisi ${i}`);
      out.push({ t: "field", v: src.slice(i + 1, end), pos: i });
      i = end + 1;
    } else if (/\d/.test(c) || (c === "." && /\d/.test(src[i + 1] ?? ""))) {
      const m = /^\d*\.?\d+(e[+-]?\d+)?/i.exec(src.slice(i))!;
      out.push({ t: "num", v: m[0], pos: i });
      i += m[0].length;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      let s = "";
      for (;;) {
        if (j >= src.length) throw new Error(`String tidak ditutup pada posisi ${i}`);
        if (src[j] === c) {
          if (src[j + 1] === c) {
            s += c;
            j += 2;
            continue;
          }
          break;
        }
        s += src[j++];
      }
      out.push({ t: "str", v: s, pos: i });
      i = j + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: "id", v: m[0], pos: i });
      i += m[0].length;
    } else if (c === "(") {
      out.push({ t: "lp", v: c, pos: i++ });
    } else if (c === ")") {
      out.push({ t: "rp", v: c, pos: i++ });
    } else if (c === ",") {
      out.push({ t: "comma", v: c, pos: i++ });
    } else {
      const two = src.slice(i, i + 2);
      if (["<=", ">=", "<>", "!=", "=="].includes(two)) {
        out.push({ t: "op", v: two, pos: i });
        i += 2;
      } else if ("+-*/%<>=&".includes(c)) {
        out.push({ t: "op", v: c, pos: i++ });
      } else {
        throw new Error(`Karakter tidak dikenal '${c}' pada posisi ${i}`);
      }
    }
  }
  out.push({ t: "eof", v: "", pos: src.length });
  return out;
}

const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;

interface FnDef {
  min: number;
  max: number;
  build: (a: string[]) => string;
}
const datePart = (a: string) => {
  const m = /^'([a-z]+)'$/.exec(a);
  if (!m || !DATE_PARTS.includes(m[1])) throw new Error(`Bagian tanggal harus salah satu dari: ${DATE_PARTS.join(", ")}`);
  return a;
};
const simple = (sql: string, min = 1, max = min): FnDef => ({ min, max, build: (a) => `${sql}(${a.join(", ")})` });

const FUNCTIONS: Record<string, FnDef> = {
  ABS: simple("abs"),
  ROUND: simple("round", 1, 2),
  FLOOR: simple("floor"),
  CEILING: simple("ceil"),
  SQRT: simple("sqrt"),
  POWER: simple("pow", 2),
  UPPER: simple("upper"),
  LOWER: simple("lower"),
  LEN: simple("length"),
  TRIM: simple("trim"),
  LEFT: simple("left", 2),
  RIGHT: simple("right", 2),
  REPLACE: simple("replace", 3),
  CONTAINS: simple("contains", 2),
  CONCAT: simple("concat", 1, 20),
  YEAR: simple("year"),
  QUARTER: simple("quarter"),
  MONTH: simple("month"),
  DAY: simple("day"),
  TODAY: { min: 0, max: 0, build: () => "current_date" },
  DATETRUNC: { min: 2, max: 2, build: (a) => `date_trunc(${datePart(a[0])}, ${a[1]})` },
  DATEDIFF: { min: 3, max: 3, build: (a) => `date_diff(${datePart(a[0])}, ${a[1]}, ${a[2]})` },
  ISNULL: { min: 1, max: 1, build: (a) => `(${a[0]} IS NULL)` },
  IFNULL: simple("coalesce", 2),
  STR: { min: 1, max: 1, build: (a) => `CAST(${a[0]} AS VARCHAR)` },
  INT: { min: 1, max: 1, build: (a) => `CAST(${a[0]} AS BIGINT)` },
  FLOAT: { min: 1, max: 1, build: (a) => `CAST(${a[0]} AS DOUBLE)` },
  MIN: simple("least", 2, 2),
  MAX: simple("greatest", 2, 2),
};

class Parser {
  private p = 0;
  private depth = 0;
  constructor(
    private toks: Tok[],
    private fields: Set<string>,
  ) {}

  private get cur() {
    return this.toks[this.p];
  }
  private at(t: TokType) {
    return this.toks[this.p].t === t;
  }
  private isKw(k: string) {
    return this.cur.t === "id" && this.cur.v.toUpperCase() === k;
  }
  private isOp(...ops: string[]) {
    return this.cur.t === "op" && ops.includes(this.cur.v);
  }
  private expectKw(k: string) {
    if (!this.isKw(k)) throw this.err(`Diharapkan ${k}`);
    this.p++;
  }
  private err(msg: string) {
    const c = this.cur;
    return new Error(`${msg} (pada posisi ${c.pos}${c.t === "eof" ? ", akhir ekspresi" : `, dekat '${c.v}'`})`);
  }

  parse(): string {
    const sql = this.or();
    if (this.cur.t !== "eof") throw this.err("Token tidak terduga");
    return sql;
  }

  private nest<T>(fn: () => T): T {
    if (++this.depth > MAX_DEPTH) throw new Error("Ekspresi terlalu dalam");
    try {
      return fn();
    } finally {
      this.depth--;
    }
  }

  private or(): string {
    let l = this.and();
    while (this.isKw("OR")) {
      this.p++;
      l = `(${l} OR ${this.and()})`;
    }
    return l;
  }
  private and(): string {
    let l = this.not();
    while (this.isKw("AND")) {
      this.p++;
      l = `(${l} AND ${this.not()})`;
    }
    return l;
  }
  private not(): string {
    if (this.isKw("NOT")) {
      this.p++;
      return `(NOT ${this.nest(() => this.not())})`;
    }
    return this.cmp();
  }
  private cmp(): string {
    const l = this.add();
    if (this.isOp("=", "==", "<>", "!=", "<", "<=", ">", ">=")) {
      const op = this.cur.v;
      this.p++;
      const sqlOp = op === "==" ? "=" : op === "!=" ? "<>" : op;
      return `(${l} ${sqlOp} ${this.add()})`;
    }
    return l;
  }
  private add(): string {
    let l = this.mul();
    while (this.isOp("+", "-", "&")) {
      const op = this.cur.v;
      this.p++;
      const r = this.mul();
      // '&' concatenates as text so mixed types behave predictably.
      l = op === "&" ? `(CAST(${l} AS VARCHAR) || CAST(${r} AS VARCHAR))` : `(${l} ${op} ${r})`;
    }
    return l;
  }
  private mul(): string {
    let l = this.unary();
    while (this.isOp("*", "/", "%")) {
      const op = this.cur.v;
      this.p++;
      const r = this.unary();
      // Division by zero yields NULL instead of an error/inf.
      l = op === "/" ? `(${l} / NULLIF(${r}, 0))` : `(${l} ${op} ${r})`;
    }
    return l;
  }
  private unary(): string {
    if (this.isOp("-")) {
      this.p++;
      return `(-${this.nest(() => this.unary())})`;
    }
    return this.primary();
  }

  private primary(): string {
    const t = this.cur;
    if (t.t === "num") {
      this.p++;
      return t.v;
    }
    if (t.t === "str") {
      this.p++;
      return sqlStr(t.v);
    }
    if (t.t === "field") {
      if (!this.fields.has(t.v)) throw this.err(`Field tidak dikenal [${t.v}]`);
      this.p++;
      return quoteId(t.v);
    }
    if (t.t === "lp") {
      this.p++;
      const e = this.nest(() => this.or());
      if (this.cur.t !== "rp") throw this.err("Diharapkan )");
      this.p++;
      return `(${e})`;
    }
    if (t.t === "id") {
      const up = t.v.toUpperCase();
      if (up === "TRUE" || up === "FALSE" || up === "NULL") {
        this.p++;
        return up;
      }
      if (up === "IF") return this.nest(() => this.ifExpr());
      if (KEYWORDS.has(up)) throw this.err(`Kata kunci ${up} tidak terduga`);
      const fn = FUNCTIONS[up];
      if (!fn) throw this.err(`Fungsi tidak dikenal ${t.v}()`);
      this.p++;
      if (this.cur.t !== "lp") throw this.err(`Diharapkan ( setelah ${up}`);
      this.p++;
      const args: string[] = [];
      if (!this.at("rp")) {
        for (;;) {
          args.push(this.nest(() => this.or()));
          if (this.at("comma")) {
            this.p++;
            continue;
          }
          break;
        }
      }
      if (!this.at("rp")) throw this.err("Diharapkan )");
      this.p++;
      if (args.length < fn.min || args.length > fn.max)
        throw new Error(`${up}() membutuhkan ${fn.min === fn.max ? fn.min : `${fn.min}-${fn.max}`} argumen, diberikan ${args.length}`);
      return fn.build(args);
    }
    throw this.err("Ekspresi tidak lengkap");
  }

  private ifExpr(): string {
    this.expectKw("IF");
    const branches: [string, string][] = [];
    let cond = this.or();
    this.expectKw("THEN");
    branches.push([cond, this.or()]);
    while (this.isKw("ELSEIF")) {
      this.p++;
      cond = this.or();
      this.expectKw("THEN");
      branches.push([cond, this.or()]);
    }
    let els = "NULL";
    if (this.isKw("ELSE")) {
      this.p++;
      els = this.or();
    }
    this.expectKw("END");
    return `(CASE ${branches.map(([c, v]) => `WHEN ${c} THEN ${v}`).join(" ")} ELSE ${els} END)`;
  }
}

export function exprToSql(expression: string, available: Field[]): string {
  if (!expression.trim()) throw new Error("Ekspresi kosong");
  return new Parser(tokenize(expression), new Set(available.map((f) => f.name))).parse();
}

export const SUPPORTED_FUNCTIONS = Object.keys(FUNCTIONS);
