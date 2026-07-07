import process from "node:process";

export function buildChildEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return overrides ? { ...process.env, ...overrides } : process.env;
}
