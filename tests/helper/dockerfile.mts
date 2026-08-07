import path from "node:path";

export type DockerfileInstruction = {
  keyword: string;
  value: string;
};

export type DockerfileStage = {
  base: string;
  name?: string;
  instructions: DockerfileInstruction[];
};

export type ParsedDockerfile = {
  instructions: DockerfileInstruction[];
  stages: DockerfileStage[];
};

export type CopyInstruction = {
  keyword: "COPY" | "ADD";
  options: Record<string, string | true>;
  sources: string[];
  destination: string;
};

type Token = { value: string; start: number };

export function parseDockerfile(source: string): ParsedDockerfile {
  const parsed: ParsedDockerfile = { instructions: [], stages: [] };
  let currentStage: DockerfileStage | undefined;

  for (const line of logicalLines(source)) {
    const match = /^([A-Za-z]+)\s+([\s\S]+)$/.exec(line);
    if (!match) throw new Error(`Invalid Dockerfile instruction: ${line}`);
    const instruction = { keyword: match[1].toUpperCase(), value: match[2].trim() };
    if (instruction.keyword === "FROM") {
      const tokens = shellTokens(instruction.value).map((token) => token.value);
      while (tokens[0]?.startsWith("--")) tokens.shift();
      const asIndex = tokens.findIndex((token) => token.toUpperCase() === "AS");
      if (!tokens[0] || (asIndex !== -1 && !tokens[asIndex + 1])) {
        throw new Error(`Invalid FROM instruction: ${instruction.value}`);
      }
      currentStage = {
        base: tokens[0],
        name: asIndex === -1 ? undefined : tokens[asIndex + 1],
        instructions: [],
      };
      parsed.stages.push(currentStage);
    } else if (currentStage) {
      currentStage.instructions.push(instruction);
    } else {
      parsed.instructions.push(instruction);
    }
  }

  return parsed;
}

export function requireDockerStage(dockerfile: ParsedDockerfile, name: string): DockerfileStage {
  const stage = dockerfile.stages.find((candidate) => candidate.name === name);
  if (!stage) throw new Error(`Docker stage ${name} is missing`);
  return stage;
}

export function copyInstructions(stage: DockerfileStage): CopyInstruction[] {
  return stage.instructions
    .filter((instruction) => instruction.keyword === "COPY" || instruction.keyword === "ADD")
    .map((instruction) => parseCopyInstruction(instruction as DockerfileInstruction & { keyword: "COPY" | "ADD" }));
}

export function copiesWholeBuildContext(copy: CopyInstruction): boolean {
  return copy.sources.some((source) => path.posix.normalize(source).replace(/\/+$/, "") === ".");
}

function logicalLines(source: string): string[] {
  const lines: string[] = [];
  let pending = "";

  for (const rawLine of source.replaceAll("\r\n", "\n").split("\n")) {
    if (/^\s*#/.test(rawLine) || /^\s*$/.test(rawLine)) continue;
    const line = rawLine.trim();
    const trailingSlashCount = /\\+\s*$/.exec(line)?.[0].trim().length ?? 0;
    const continued = trailingSlashCount % 2 === 1;
    const part = continued ? line.replace(/\\\s*$/, "").trimEnd() : line;
    pending = pending ? `${pending} ${part.trimStart()}` : part;
    if (!continued) {
      lines.push(pending);
      pending = "";
    }
  }

  if (pending) throw new Error("Dockerfile ends with an unterminated continuation");
  return lines;
}

function parseCopyInstruction(instruction: DockerfileInstruction & { keyword: "COPY" | "ADD" }): CopyInstruction {
  const tokens = shellTokens(instruction.value);
  const options: Record<string, string | true> = {};
  let operandIndex = 0;
  while (tokens[operandIndex]?.value.startsWith("--")) {
    const option = tokens[operandIndex].value.slice(2);
    const equalsIndex = option.indexOf("=");
    options[equalsIndex === -1 ? option : option.slice(0, equalsIndex)] = equalsIndex === -1 ? true : option.slice(equalsIndex + 1);
    operandIndex++;
  }

  const operandStart = tokens[operandIndex]?.start;
  if (operandStart === undefined) throw new Error(`${instruction.keyword} has no operands`);
  const operandsText = instruction.value.slice(operandStart).trim();
  let operands: string[];
  if (operandsText.startsWith("[")) {
    const value: unknown = JSON.parse(operandsText);
    if (!Array.isArray(value) || !value.every((operand) => typeof operand === "string")) {
      throw new Error(`${instruction.keyword} JSON operands must be strings`);
    }
    operands = value;
  } else {
    operands = tokens.slice(operandIndex).map((token) => token.value);
  }

  if (operands.length < 2) throw new Error(`${instruction.keyword} requires a source and destination`);
  return {
    keyword: instruction.keyword,
    options,
    sources: operands.slice(0, -1),
    destination: operands.at(-1)!,
  };
}

function shellTokens(value: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < value.length) {
    while (/\s/.test(value[index] ?? "")) index++;
    if (index >= value.length) break;
    const start = index;
    let token = "";
    let quote: "'" | '"' | undefined;
    while (index < value.length) {
      const character = value[index];
      if (!quote && /\s/.test(character)) break;
      if (character === "'" || character === '"') {
        if (!quote) quote = character;
        else if (quote === character) quote = undefined;
        else token += character;
        index++;
      } else if (character === "\\" && quote !== "'") {
        index++;
        if (index < value.length) token += value[index++];
      } else {
        token += character;
        index++;
      }
    }
    if (quote) throw new Error(`Unterminated quote in Dockerfile instruction: ${value}`);
    tokens.push({ value: token, start });
  }
  return tokens;
}
