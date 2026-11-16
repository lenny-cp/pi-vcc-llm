import { describe, expect, test } from "bun:test";
import {
  SemanticClientError,
  requestSemanticCompletion,
} from "../src/semantic/client";
import type { SemanticCompactionSettings } from "../src/core/settings";

const settings: SemanticCompactionSettings = {
  enabled: true,
  endpoint: "http://127.0.0.1:8080/v1/chat/completions",
  model: "default",
  apiKey: "secret",
  timeoutMs: 30000,
  maxInputChars: 80000,
  maxOutputTokens: 1600,
  temperature: 0.1,
  disableThinking: true,
  includeToolMetadata: true,
  maxThinkingChars: 0,
  failureMode: "vcc-only",
};
const prompts = { system: "system", user: "user" };

describe("OpenAI-compatible semantic client", () => {
  test("sends chat completions parameters and optional bearer auth", async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    const content = await requestSemanticCompletion({
      settings,
      model: "active-model",
      prompts,
      jsonSchema: {
        name: "semantic_memory",
        schema: { type: "object" },
      },
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(url), init };
        return new Response(JSON.stringify({
          choices: [{ message: { content: "{\"schemaVersion\":1}" } }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    expect(content).toBe("{\"schemaVersion\":1}");
    expect(captured.url).toBe(settings.endpoint);
    expect((captured.init?.headers as Record<string, string>).authorization).toBe("Bearer secret");
    const body = JSON.parse(String(captured.init?.body));
    expect(body.model).toBe("active-model");
    expect(body.max_tokens).toBe(1600);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "semantic_memory",
        strict: true,
        schema: { type: "object" },
      },
    });
    expect(body.messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "user" },
    ]);
  });

  test("falls back to the legacy configured model for direct callers", async () => {
    let body: any;
    await requestSemanticCompletion({
      settings,
      prompts,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          choices: [{ message: { content: "{}" } }],
        }), { status: 200 });
      }) as typeof fetch,
    });
    expect(body.model).toBe("default");
  });

  test("omits authorization when no key is configured", async () => {
    let headers: Record<string, string> = {};
    await requestSemanticCompletion({
      settings: { ...settings, apiKey: "" },
      prompts,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        headers = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({
          choices: [{ message: { content: "{}" } }],
        }), { status: 200 });
      }) as typeof fetch,
    });
    expect(headers.authorization).toBeUndefined();
  });

  test("classifies HTTP and empty-response failures", async () => {
    await expect(requestSemanticCompletion({
      settings,
      prompts,
      fetchImpl: (async () => new Response("no", { status: 500 })) as typeof fetch,
    })).rejects.toMatchObject({ code: "http" });

    await expect(requestSemanticCompletion({
      settings,
      prompts,
      fetchImpl: (async () => new Response(JSON.stringify({ choices: [] }), {
        status: 200,
      })) as typeof fetch,
    })).rejects.toMatchObject({ code: "empty-response" });
  });

  test("times out and honors a parent abort signal", async () => {
    const waitingFetch = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      })) as typeof fetch;

    await expect(requestSemanticCompletion({
      settings: { ...settings, timeoutMs: 5 },
      prompts,
      fetchImpl: waitingFetch,
    })).rejects.toMatchObject({ code: "timeout" });

    const controller = new AbortController();
    controller.abort();
    try {
      await requestSemanticCompletion({
        settings,
        prompts,
        signal: controller.signal,
        fetchImpl: waitingFetch,
      });
      throw new Error("expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SemanticClientError);
      expect((error as SemanticClientError).code).toBe("aborted");
    }
  });
});
