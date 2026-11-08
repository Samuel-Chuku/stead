import { describe, it, expect, vi, afterEach } from "vitest";

// Settings from the process environment only (no .env file), so "no key" really means no key.
vi.mock("../src/config.js", () => ({
  REPO: "/tmp",
  hasEnv: (n: string) => Boolean(process.env[n]),
  env: (n: string, f?: string) => {
    const v = process.env[n] || f;
    if (!v) throw new Error(`missing ${n}`);
    return v;
  },
}));
const { aiEnabled } = await import("../src/ai.js");

const ENV = ["AI_BASE_URL", "AI_API_KEY", "AI_MODEL", "NEAR_AI_API_KEY"];
afterEach(() => {
  for (const k of ENV) delete process.env[k];
});

describe("AI is off unless a key is set", () => {
  it("nothing set: off", () => {
    expect(aiEnabled()).toBe(false);
  });
  it("the base URL pinned by our compose file, no key: off", () => {
    process.env.AI_BASE_URL = "https://cloud-api.near.ai/v1";
    expect(aiEnabled()).toBe(false);
  });
  it("another provider's base URL alone: off", () => {
    process.env.AI_BASE_URL = "https://api.example.com/v1";
    expect(aiEnabled()).toBe(false);
  });
  it("a key: on", () => {
    process.env.AI_BASE_URL = "https://cloud-api.near.ai/v1";
    process.env.NEAR_AI_API_KEY = "k";
    expect(aiEnabled()).toBe(true);
  });
  it("a keyless local server, named with base URL and model: on", () => {
    process.env.AI_BASE_URL = "http://127.0.0.1:11434/v1";
    process.env.AI_MODEL = "llama3";
    expect(aiEnabled()).toBe(true);
  });
  it("NEAR AI without a key never turns on, even with a model named", () => {
    process.env.AI_BASE_URL = "https://cloud-api.near.ai/v1";
    process.env.AI_MODEL = "z-ai/glm-5.3-flash";
    expect(aiEnabled()).toBe(false);
  });
});
