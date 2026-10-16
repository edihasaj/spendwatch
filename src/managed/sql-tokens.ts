export interface SqlToken {
  kind: "word" | "quoted" | "string" | "parameter" | "number" | "symbol" | "fragment";
  text: string;
  name?: string;
}

export function quoteIdentifier(name: string): string {
  return '"' + name.replaceAll('"', '""') + '"';
}
export function word(token: SqlToken | undefined, value: string): boolean {
  return token?.kind === "word" && token.text.toUpperCase() === value;
}
export function render(tokens: readonly SqlToken[]): string {
  return tokens.map((token) => token.text).join(" ");
}

/** Tokenize our SQL subset without interpreting values inside strings/comments. */
export function sqlTokens(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;
  while (index < sql.length) {
    const start = index, character = sql[index]!;
    if (/\s/.test(character)) { index++; continue; }
    if (sql.startsWith("--", index)) {
      const end = sql.indexOf("\n", index + 2);
      index = end < 0 ? sql.length : end + 1; continue;
    }
    if (sql.startsWith("/*", index)) {
      const end = sql.indexOf("*/", index + 2);
      if (end < 0) throw new Error("Unterminated SQL comment");
      index = end + 2; continue;
    }
    if (character === "'" || character === '"' || character === "`" || character === "[") {
      const closing = character === "[" ? "]" : character;
      let name = "", closed = false;
      index++;
      while (index < sql.length) {
        if (sql[index] === closing) {
          if (sql[index + 1] === closing) { name += closing; index += 2; continue; }
          index++; closed = true; break;
        }
        name += sql[index++]!;
      }
      if (!closed) throw new Error("Unterminated SQL quotation");
      tokens.push(character === "'" ? { kind: "string", text: sql.slice(start, index) } :
        { kind: "quoted", text: quoteIdentifier(name), name });
      continue;
    }
    if (character === "?") {
      index++;
      while (/\d/.test(sql[index] ?? "")) index++;
      tokens.push({ kind: "parameter", text: sql.slice(start, index) });
      continue;
    }
    const number = sql.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
    if (number) {
      index += number[0].length; tokens.push({ kind: "number", text: number[0] }); continue;
    }
    const identifier = sql.slice(index).match(/^[a-zA-Z_\u0080-\uffff][a-zA-Z_0-9$\u0080-\uffff]*/);
    if (identifier) {
      index += identifier[0].length;
      tokens.push({ kind: "word", text: identifier[0], name: identifier[0] }); continue;
    }
    const operator = ["->>", ">=", "<=", "<>", "!=", "||", "<<", ">>", "::", "->"]
      .find((candidate) => sql.startsWith(candidate, index));
    index += operator?.length ?? 1;
    tokens.push({ kind: "symbol", text: operator ?? character });
  }
  return tokens;
}

export function sqlStatements(sql: string): string[] {
  const result: string[] = [], current: SqlToken[] = [];
  for (const token of sqlTokens(sql)) {
    if (token.text === ";" && token.kind === "symbol") {
      if (current.length) result.push(render(current));
      current.length = 0;
    } else current.push(token);
  }
  if (current.length) result.push(render(current));
  return result;
}

export function matchingParen(tokens: readonly SqlToken[], start: number): number {
  let depth = 0;
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index]!.kind !== "symbol") continue;
    if (tokens[index]!.text === "(") depth++;
    if (tokens[index]!.text === ")" && --depth === 0) return index;
  }
  throw new Error("Unbalanced SQL parentheses");
}
