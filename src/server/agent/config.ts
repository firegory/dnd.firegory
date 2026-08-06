import { readFileSync } from "node:fs";

export function readSecret(environmentName: string, fileEnvironmentName: string, environment: NodeJS.ProcessEnv = process.env): string {
  const value = readConfig(environmentName, fileEnvironmentName, environment);
  if (Buffer.byteLength(value, "utf8") < 32) throw new Error(`${environmentName} must contain at least 32 bytes.`);
  return value;
}

export function readConfig(environmentName: string, fileEnvironmentName: string, environment: NodeJS.ProcessEnv = process.env): string {
  const inline = environment[environmentName];
  const file = environment[fileEnvironmentName];
  if (inline && file) throw new Error(`${environmentName} and ${fileEnvironmentName} are mutually exclusive.`);
  const value = file ? readFileSync(file, "utf8").trim() : inline?.trim();
  if (!value) throw new Error(`${fileEnvironmentName} is required (or ${environmentName} for development).`);
  return value;
}
