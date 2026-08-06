import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadSettings,
} from "../src/core/settings";

const defaults = {
  enabled: false,
  endpoint: "http://127.0.0.1:8080/v1/chat/completions",
  apiKey: "",
  timeoutMs: 30000,
  maxInputChars: 80000,
  maxOutputTokens: 900,
  temperature: 0.1,
  disableThinking: true,
  includeToolMetadata: true,
  failureMode: "vcc-only",
};

let directory: string;
let configPath: string;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "pi-vcc-semantic-settings-"));
  configPath = join(directory, "pi-vcc-config.json");
  process.env.PI_VCC_CONFIG_PATH = configPath;
});

afterAll(() => {
  delete process.env.PI_VCC_CONFIG_PATH;
  rmSync(directory, { recursive: true, force: true });
});

describe("semantic compaction settings", () => {
  test("defaults to fully disabled", () => {
    writeFileSync(configPath, "{}");
    expect(loadSettings().semanticCompaction).toEqual(defaults);
  });

  test("deep-merges a partial semantic block", () => {
    writeFileSync(configPath, JSON.stringify({
      semanticCompaction: {
        enabled: true,
        endpoint: " http://localhost:9999/v1/chat/completions ",
        includeToolMetadata: false,
        disableThinking: false,
      },
    }));
    const settings = loadSettings().semanticCompaction;
    expect(settings.enabled).toBe(true);
    expect(settings.endpoint).toBe("http://localhost:9999/v1/chat/completions");
    expect(settings.model).toBeUndefined();
    expect(settings.disableThinking).toBe(false);
    expect(settings.includeToolMetadata).toBe(false);
    expect(settings.failureMode).toBe("vcc-only");
  });

  test("replaces invalid values with safe defaults", () => {
    writeFileSync(configPath, JSON.stringify({
      semanticCompaction: {
        enabled: "yes",
        endpoint: "",
        timeoutMs: -1,
        maxInputChars: 12,
        maxOutputTokens: 0,
        temperature: 99,
        failureMode: "abort",
      },
    }));
    expect(loadSettings().semanticCompaction).toEqual(
      defaults,
    );
  });
});
