import { matchingParen, quoteIdentifier, render, sqlTokens, word, type SqlToken } from "./sql-tokens";

const fragment = (text: string): SqlToken => ({ kind: "fragment", text });
const comparison = new Set(["=", "!=", "<>", "<", ">", "<=", ">="]);
const keywords = new Set(("SELECT FROM WHERE AS AND OR NOT JOIN CROSS INNER LEFT RIGHT FULL ON " +
  "ORDER BY GROUP HAVING LIMIT OFFSET VALUES INSERT INTO UPDATE SET DELETE CREATE TABLE INDEX IF EXISTS " +
  "PRIMARY KEY UNIQUE FOREIGN REFERENCES CONSTRAINT CHECK DEFAULT COLLATE NULL IS CASE WHEN THEN ELSE END " +
  "WITH MATERIALIZED OVER PARTITION ASC DESC DISTINCT CONFLICT DO NOTHING RETURNING BEGIN COMMIT ROLLBACK " +
  "SAVEPOINT RELEASE INTEGER REAL TEXT BLOB CAST BIGINT DOUBLE PRECISION IDENTITY GENERATED ALWAYS " +
  "TRANSACTION DEFERRED IMMEDIATE EXCLUSIVE UNION ALL BETWEEN IN LIKE").split(" "));
function operandStart(tokens: SqlToken[], end: number): number {
  if (tokens[end]?.text === ")") {
    let depth = 1, start = end - 1;
    while (start >= 0) {
      if (tokens[start]!.text === ")") depth++;
      if (tokens[start]!.text === "(" && --depth === 0) {
        return tokens[start - 1]?.kind === "word" ? start - 1 : start;
      }
      start--;
    }
    throw new Error("Unbalanced SQL operand");
  }
  let start = end;
  while (tokens[start - 1]?.text === "." && start >= 2) start -= 2;
  return start;
}
function operandEnd(tokens: SqlToken[], start: number): number {
  let end = start;
  if (tokens[start + 1]?.text === "(") return matchingParen(tokens, start + 1);
  while (tokens[end + 1]?.text === "." && tokens[end + 2]) end += 2;
  return end;
}

function noCase(tokens: SqlToken[]): void {
  for (;;) {
    const index = tokens.findIndex((token) => word(token, "COLLATE"));
    if (index < 0) return;
    if (!word(tokens[index + 1], "NOCASE")) throw new Error("Unadmitted SQL collation");
    const start = operandStart(tokens, index - 1);
    const value = render(tokens.slice(start, index));
    const before = tokens[start - 1], after = tokens[index + 2];
    if (before && comparison.has(before.text)) {
      const left = operandStart(tokens, start - 2);
      const other = render(tokens.slice(left, start - 1));
      tokens.splice(left, index + 2 - left, fragment(
        `sqlite_nocase(${other}) ${before.text} sqlite_nocase(${value})`));
    } else if (after && comparison.has(after.text)) {
      const right = operandEnd(tokens, index + 3);
      const other = render(tokens.slice(index + 3, right + 1));
      tokens.splice(start, right + 1 - start, fragment(
        `sqlite_nocase(${value}) ${after.text} sqlite_nocase(${other})`));
    } else {
      tokens.splice(start, index + 2 - start, fragment(`sqlite_nocase(${value})`));
    }
  }
}

function scalarMinMax(tokens: SqlToken[]): void {
  for (let index = tokens.length - 1; index >= 0; index--) {
    const token = tokens[index];
    if ((!word(token, "MIN") && !word(token, "MAX")) || tokens[index + 1]?.text !== "(") continue;
    const close = matchingParen(tokens, index + 1), args: SqlToken[][] = [[]];
    let depth = 0;
    for (const item of tokens.slice(index + 2, close)) {
      if (item.text === "(") depth++;
      if (item.text === ")") depth--;
      if (item.text === "," && depth === 0) args.push([]);
      else args.at(-1)!.push(item);
    }
    if (args.length < 2) continue; // Ordinary aggregate keeps SQLite's NULL behavior.
    const values = args.map(render), functionName = word(token, "MAX") ? "GREATEST" : "LEAST";
    tokens.splice(index, close + 1 - index, fragment(
      `(CASE WHEN ${values.map((value) => `(${value}) IS NULL`).join(" OR ")} ` +
      `THEN NULL ELSE ${functionName}(${values.join(",")}) END)`));
  }
}

export interface TranslatedSql { sql: string; insertTable?: string; }
function qualifyUpsert(tokens: SqlToken[], table: string, columns: ReadonlySet<string>): void {
  const start = tokens.findIndex((token, index) =>
    word(token, "DO") && word(tokens[index + 1], "UPDATE") && word(tokens[index + 2], "SET"));
  if (start < 0) return;
  let depth = 0, assignment = true, where = false;
  for (let index = start + 3; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (word(token, "RETURNING") && depth === 0) break;
    if (word(token, "WHERE") && depth === 0) { where = true; assignment = false; continue; }
    if (token.text === "(") depth++;
    if (token.text === ")") depth--;
    if (token.text === "," && depth === 0 && !where) { assignment = true; continue; }
    if (token.text === "=" && assignment) { assignment = false; continue; }
    if (!assignment && token.name && columns.has(token.name) &&
        tokens[index - 1]?.text !== "." && tokens[index + 1]?.text !== "." &&
        tokens[index + 1]?.text !== "(") {
      tokens[index] = fragment(quoteIdentifier(table) + "." + quoteIdentifier(token.name));
    }
  }
}

export function translateSql(sql: string, insertColumns?: ReadonlySet<string>): TranslatedSql {
  const tokens = sqlTokens(sql).filter((token) => token.text !== ";" || token.kind !== "symbol");
  let bind = 0;
  for (const [index, token] of tokens.entries()) {
    if (token.kind === "parameter") {
      const explicit = token.text.slice(1);
      const position = explicit ? Number(explicit) : bind + 1;
      if (!Number.isSafeInteger(position) || position < 1) throw new Error("Invalid SQL parameter");
      bind = Math.max(bind, position); token.text = "$" + position;
    }
    if (word(token, "BLOB")) token.text = "BYTEA";
    if (word(token, "REAL")) token.text = "DOUBLE PRECISION";
    if (word(token, "INTEGER")) token.text = "BIGINT";
    if (word(token, "MAIN") && tokens[index + 1]?.text === ".") token.text = "public";
  }
  if (word(tokens[0], "ATTACH") || word(tokens[0], "DETACH") || word(tokens[0], "VACUUM")) {
    throw new Error("Managed history archives require the managed archive path");
  }
  if (word(tokens[0], "PRAGMA")) throw new Error("PRAGMA requires explicit managed handling");
  // A legacy sample can contain NUL in SQLite TEXT. This field uses a tagged
  // byte representation; application reads decode it back to its original kind.
  const tableIndex = tokens.findIndex((token, index) => word(token, "TABLE") && word(tokens[index - 1], "CREATE"));
  if (tableIndex >= 0) {
    let index = tableIndex + 1;
    if (word(tokens[index], "IF")) index += 3;
    if (tokens[index]?.name === "samples") {
      for (let field = index + 1; field < tokens.length - 1; field++) {
        if (tokens[field]?.name === "detail" && word(tokens[field + 1], "TEXT")) tokens[field + 1]!.text = "BYTEA";
      }
    }
  }
  for (let index = 0; index < tokens.length; index++) {
    if (word(tokens[index], "BIGINT") && word(tokens[index + 1], "PRIMARY") && word(tokens[index + 2], "KEY")) {
      tokens[index] = fragment("BIGINT GENERATED BY DEFAULT AS IDENTITY");
    }
    if (word(tokens[index], "AUTOINCREMENT")) tokens.splice(index--, 1);
  }
  const aliases = new Map<string, string>();
  for (let index = 0; index < tokens.length; index++) {
    if (word(tokens[index], "AS") && tokens[index + 1]?.kind === "quoted") {
      const name = tokens[index + 1]!.name!;
      aliases.set(name.toLowerCase(), name);
    }
  }
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.kind !== "word" || tokens[index + 1]?.text === "(" || keywords.has(token.text.toUpperCase())) continue;
    const alias = aliases.get(token.text.toLowerCase());
    if (alias || /[a-z][A-Z]/.test(token.text)) {
      token.kind = "quoted"; token.text = quoteIdentifier(alias ?? token.name!);
    }
  }
  // PostgreSQL folds bare aliases to lowercase; SQLite preserves their spelling.
  const functions: (string | undefined)[] = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index]!.text === "(") functions.push(tokens[index - 1]?.text.toUpperCase());
    else if (tokens[index]!.text === ")") functions.pop();
    else if (word(tokens[index], "AS") && functions.at(-1) !== "CAST") {
      const alias = tokens[index + 1];
      if (alias?.kind === "word" && !["SELECT", "MATERIALIZED", "NOT", "WITH", "VALUES"]
          .some((keyword) => word(alias, keyword))) {
        alias.kind = "quoted"; alias.text = quoteIdentifier(alias.name!);
      }
    }
  }
  const ignore = word(tokens[0], "INSERT") && word(tokens[1], "OR") && word(tokens[2], "IGNORE");
  if (ignore) tokens.splice(1, 2);
  // SQLite permits ON after CROSS JOIN as a planner-order hint. PostgreSQL
  // uses ordinary JOIN for the same predicate and retains MATERIALIZED CTEs.
  for (let index = 0; index < tokens.length; index++) {
    if (!word(tokens[index], "CROSS") || !word(tokens[index + 1], "JOIN")) continue;
    let depth = 0, predicate = false;
    for (let next = index + 2; next < tokens.length; next++) {
      if (tokens[next]!.text === "(") depth++;
      if (tokens[next]!.text === ")") { if (!depth) break; depth--; }
      if (!depth && word(tokens[next], "ON")) { predicate = true; break; }
      if (!depth && ["JOIN", "CROSS", "LEFT", "RIGHT", "WHERE", "GROUP", "ORDER", "LIMIT"]
          .some((keyword) => word(tokens[next], keyword))) break;
    }
    if (predicate) tokens.splice(index--, 1);
  }
  const insert = word(tokens[0], "INSERT") && word(tokens[1], "INTO") ? tokens[2] : undefined;
  const insertTable = insert ? (tokens[3]?.text === "." ? tokens[4]?.name : insert.name) : undefined;
  if (insertTable && insertColumns) qualifyUpsert(tokens, insertTable, insertColumns);
  noCase(tokens);
  scalarMinMax(tokens);
  if (ignore && !tokens.some((token) => word(token, "CONFLICT"))) {
    const returning = tokens.findIndex((token) => word(token, "RETURNING"));
    tokens.splice(returning < 0 ? tokens.length : returning, 0, fragment("ON CONFLICT DO NOTHING"));
  }
  return { sql: render(tokens), insertTable };
}
