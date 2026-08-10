const MAX_STRUCTURED_SCAN_CHARS = 64 * 1024;
const MAX_STRUCTURED_LINES = 512;
const MAX_EXPRESSION_TOKENS = 512;

type Token = Readonly<{
  kind: "number" | "identifier" | "operator" | "left" | "right" | "comma";
  value: string;
  start: number;
  end: number;
}>;

export function isCoherentStructuredContent(text: string): boolean {
  if (text.length === 0 || text.length > MAX_STRUCTURED_SCAN_CHARS) return false;
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || lines.length > MAX_STRUCTURED_LINES) return false;
  if (isEquationDocument(lines)) return true;
  if (isMatrix(text, lines)) return true;
  return isNumericTable(lines);
}

function isEquationDocument(lines: readonly string[]): boolean {
  const equations = lines.filter(isEquation);
  return equations.length >= 1 && equations.length / lines.length >= 0.6;
}

function isEquation(line: string): boolean {
  const tokens = tokenize(line);
  if (!tokens) return false;
  if (isCompactRelationGroupSequence(line, tokens.length)) return true;
  const parser = new ExpressionParser(tokens);
  return parser.parseRelationSequence();
}

function isCompactRelationGroupSequence(line: string, totalTokens: number): boolean {
  const groups = line.split(/\s+/u).filter(Boolean);
  if (groups.length < 2) return false;
  let consumedTokens = 0;
  for (const group of groups) {
    const tokens = tokenize(group);
    if (!tokens || tokens.length === 0) return false;
    consumedTokens += tokens.length;
    if (consumedTokens > MAX_EXPRESSION_TOKENS) return false;
    if (!new ExpressionParser(tokens).parseSingleRelation()) return false;
  }
  return consumedTokens === totalTokens;
}

function isMatrix(text: string, lines: readonly string[]): boolean {
  let rows: readonly string[] = [];
  const compact = text.trim();
  if (compact.startsWith("[[") && compact.endsWith("]]")) {
    rows = splitTopLevel(compact.slice(1, -1), ",") ?? [];
  } else if (lines.length === 1 && compact.startsWith("[") && compact.endsWith("]") && compact.includes(";")) {
    rows = splitTopLevel(compact.slice(1, -1), ";") ?? [];
  } else if (lines.length >= 2 && lines.every((line) => line.startsWith("[") && line.endsWith("]"))) {
    rows = lines;
  }
  if (rows.length < 2) return false;

  const widths: number[] = [];
  for (const row of rows) {
    const body = row.trim().replace(/^\[/u, "").replace(/\]$/u, "");
    const commaCells = splitTopLevel(body, ",");
    const cells = commaCells && commaCells.length >= 2 ? commaCells : body.split(/\s+/u).filter(Boolean);
    if (!cells || cells.length < 2 || !cells.every(isArithmeticExpression)) return false;
    widths.push(cells.length);
  }
  return widths.every((width) => width === widths[0]);
}

function isNumericTable(lines: readonly string[]): boolean {
  for (const delimiter of [",", ";", "|", "\t"]) {
    const rows = lines.map((line) => line.split(delimiter).map((cell) => cell.trim()));
    if (rows[0].length < 2 || !rows.every((row) => row.length === rows[0].length)) continue;
    if (rows.length === 1) {
      if (rows[0].length >= 3 && rows[0].every(isNumericCell)) return true;
      continue;
    }
    const dataStart = rows[0].every(isHeaderCell) ? 1 : 0;
    if (dataStart < rows.length && rows.slice(dataStart).every((row) => row.every(isNumericCell))) return true;
  }

  const rows = lines.map((line) => line.split(/\s+/u));
  if (rows[0].length < 3 || !rows.every((row) => row.length === rows[0].length)) return false;
  return rows.length === 1
    ? rows[0].every(isNumericCell)
    : rows.every((row) => row.every(isNumericCell));
}

function isNumericCell(value: string): boolean {
  return /^[+\-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+\-]?\d+)?%?$/iu.test(value);
}

function isHeaderCell(value: string): boolean {
  return /^[\p{L}_][\p{L}\p{N}_.\-]*$/u.test(value);
}

function isArithmeticExpression(value: string): boolean {
  const tokens = tokenize(value);
  if (!tokens) return false;
  const parser = new ExpressionParser(tokens);
  return parser.parseArithmeticOnly();
}

function splitTopLevel(value: string, delimiter: string): readonly string[] | null {
  const result: string[] = [];
  const stack: string[] = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === "(" || character === "[" || character === "{") stack.push(character);
    else if (character in pairs && stack.pop() !== pairs[character]) return null;
    else if (character === delimiter && stack.length === 0) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (stack.length > 0) return null;
  result.push(value.slice(start).trim());
  return result.every(Boolean) ? result : null;
}

function tokenize(value: string): readonly Token[] | null {
  const tokens: Token[] = [];
  const matcher = /\s*(?:(\d+(?:\.\d+)?(?:e[+\-]?\d+)?)|([\p{L}_][\p{L}\p{N}_]*)|(>=|<=|\*\*|=|<|>|\+|-|\*|\/|\^|\(|\)|,))/iyu;
  let index = 0;
  while (index < value.length) {
    matcher.lastIndex = index;
    const match = matcher.exec(value);
    if (!match || match.index !== index) return null;
    index = matcher.lastIndex;
    const raw = match[0].trim();
    const start = match.index + match[0].search(/\S/u);
    const token = { value: raw, start, end: start + raw.length };
    if (match[1]) tokens.push({ kind: "number", ...token });
    else if (match[2]) tokens.push({ kind: "identifier", ...token });
    else if (raw === "(") tokens.push({ kind: "left", ...token });
    else if (raw === ")") tokens.push({ kind: "right", ...token });
    else if (raw === ",") tokens.push({ kind: "comma", ...token });
    else tokens.push({ kind: "operator", ...token });
    if (tokens.length > MAX_EXPRESSION_TOKENS) return null;
  }
  return tokens.length > 0 ? tokens : null;
}

class ExpressionParser {
  private index = 0;
  private readonly tokens: readonly Token[];

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  parseRelationSequence(): boolean {
    let relations = 0;
    while (this.index < this.tokens.length) {
      const start = this.index;
      if (!this.parseExpression()) return false;
      if (!this.takeOperator(["=", "<", ">", "<=", ">="])) return false;
      if (!this.parseExpression() || this.index <= start) return false;
      relations++;
      if (this.index === this.tokens.length) return relations > 0;
      const previous = this.tokens[this.index - 1];
      const next = this.tokens[this.index];
      if (next.start <= previous.end) return false;
    }
    return false;
  }

  parseSingleRelation(): boolean {
    if (!this.parseExpression()) return false;
    if (!this.takeOperator(["=", "<", ">", "<=", ">="])) return false;
    return this.parseExpression() && this.index === this.tokens.length;
  }

  parseArithmeticOnly(): boolean {
    return this.parseExpression() && this.index === this.tokens.length;
  }

  private parseExpression(): boolean {
    if (!this.parseTerm()) return false;
    while (this.takeOperator(["+", "-"])) {
      if (!this.parseTerm()) return false;
    }
    return true;
  }

  private parseTerm(): boolean {
    if (!this.parsePower()) return false;
    while (this.takeOperator(["*", "/"])) {
      if (!this.parsePower()) return false;
    }
    return true;
  }

  private parsePower(): boolean {
    if (!this.parseUnary()) return false;
    if (this.takeOperator(["^", "**"])) return this.parsePower();
    return true;
  }

  private parseUnary(): boolean {
    this.takeOperator(["+", "-"]);
    return this.parsePrimary();
  }

  private parsePrimary(): boolean {
    const token = this.tokens[this.index];
    if (!token) return false;
    if (token.kind === "number") {
      this.index++;
      return true;
    }
    if (token.kind === "identifier") {
      this.index++;
      if (this.tokens[this.index]?.kind !== "left") return true;
      this.index++;
      if (!this.parseExpression()) return false;
      while (this.tokens[this.index]?.kind === "comma") {
        this.index++;
        if (!this.parseExpression()) return false;
      }
      if (this.tokens[this.index]?.kind !== "right") return false;
      this.index++;
      return true;
    }
    if (token.kind !== "left") return false;
    this.index++;
    if (!this.parseExpression() || this.tokens[this.index]?.kind !== "right") return false;
    this.index++;
    return true;
  }

  private takeOperator(allowed: readonly string[]): boolean {
    const token = this.tokens[this.index];
    if (token?.kind !== "operator" || !allowed.includes(token.value)) return false;
    this.index++;
    return true;
  }
}
