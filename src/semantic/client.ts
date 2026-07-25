import type { SemanticCompactionSettings } from "../core/settings";

export type SemanticClientFailure =
  | "aborted"
  | "timeout"
  | "network"
  | "http"
  | "empty-response";

export class SemanticClientError extends Error {
  constructor(public readonly code: SemanticClientFailure) {
    super(code);
    this.name = "SemanticClientError";
  }
}

export interface SemanticCompletionPrompts {
  system: string;
  user: string;
}

export const requestSemanticCompletion = async (options: {
  settings: SemanticCompactionSettings;
  prompts: SemanticCompletionPrompts;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<string> => {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", abortFromParent, { once: true });

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.settings.timeoutMs);

  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.settings.apiKey) {
      headers.authorization = `Bearer ${options.settings.apiKey}`;
    }
    let response: Response;
    try {
      if (controller.signal.aborted) throw new SemanticClientError("aborted");
      response = await (options.fetchImpl ?? fetch)(options.settings.endpoint, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: options.settings.model,
          messages: [
            { role: "system", content: options.prompts.system },
            { role: "user", content: options.prompts.user },
          ],
          max_tokens: options.settings.maxOutputTokens,
          temperature: options.settings.temperature,
        }),
      });
    } catch {
      if (timedOut) throw new SemanticClientError("timeout");
      if (controller.signal.aborted) throw new SemanticClientError("aborted");
      throw new SemanticClientError("network");
    }
    if (timedOut) throw new SemanticClientError("timeout");
    if (controller.signal.aborted) throw new SemanticClientError("aborted");
    if (!response.ok) throw new SemanticClientError("http");

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new SemanticClientError("empty-response");
    }
    if (timedOut) throw new SemanticClientError("timeout");
    if (controller.signal.aborted) throw new SemanticClientError("aborted");
    const content = (payload as any)?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new SemanticClientError("empty-response");
    }
    return content;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromParent);
  }
};
