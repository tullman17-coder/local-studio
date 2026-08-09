import { Effect } from "effect";
import {
  outputImagesFromHistory,
  type ComfyOutputImage,
  type ComfyWorkflow,
} from "./comfy-workflow";

export type ComfyFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Effect.Effect<Response, Error>;

export type ComfyClientOptions = {
  baseUrl: string;
  fetcher?: ComfyFetch;
  pollIntervalMs?: number;
  timeoutMs?: number;
};

export type ComfyImage = {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
};

function validPromptId(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function requestError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

const liveFetch: ComfyFetch = (input, init) =>
  Effect.tryPromise({ try: () => fetch(input, init), catch: requestError });

function responseJson(response: Response): Effect.Effect<unknown, Error> {
  if (!response.ok)
    return Effect.fail(new Error(`ComfyUI request failed with HTTP ${response.status}`));
  return Effect.tryPromise({ try: () => response.json(), catch: requestError });
}

export class ComfyClient {
  private readonly baseUrl: string;
  private readonly fetcher: ComfyFetch;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;

  constructor(options: ComfyClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetcher = options.fetcher ?? liveFetch;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.timeoutMs = options.timeoutMs ?? 600_000;
  }

  submit(workflow: ComfyWorkflow): Effect.Effect<string, Error> {
    const fetcher = this.fetcher;
    const url = `${this.baseUrl}/prompt`;
    return Effect.gen(function* () {
      const response = yield* fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: workflow }),
      });
      const payload = (yield* responseJson(response)) as { prompt_id?: unknown };
      if (typeof payload.prompt_id !== "string" || !validPromptId(payload.prompt_id)) {
        return yield* Effect.fail(new Error("ComfyUI returned an invalid prompt id"));
      }
      return payload.prompt_id;
    });
  }

  history(promptId: string): Effect.Effect<unknown, Error> {
    if (!validPromptId(promptId)) return Effect.fail(new Error("Invalid prompt id"));
    return this.fetcher(`${this.baseUrl}/history/${promptId}`).pipe(
      Effect.flatMap(responseJson),
      Effect.map((payload) => (payload as Record<string, unknown>)[promptId] ?? null),
    );
  }

  waitForImages(promptId: string): Effect.Effect<ComfyOutputImage[], Error> {
    const startedAt = Date.now();
    const timeoutMs = this.timeoutMs;
    const pollIntervalMs = this.pollIntervalMs;
    const readHistory = (): Effect.Effect<unknown, Error> => this.history(promptId);
    return Effect.gen(function* () {
      while (Date.now() - startedAt <= timeoutMs) {
        const images = outputImagesFromHistory(yield* readHistory());
        if (images.length > 0) return images;
        if (pollIntervalMs > 0) yield* Effect.sleep(`${pollIntervalMs} millis`);
      }
      return yield* Effect.fail(new Error(`ComfyUI generation ${promptId} timed out`));
    });
  }

  fetchImage(promptId: string, index: number): Effect.Effect<ComfyImage, Error> {
    if (!validPromptId(promptId)) return Effect.fail(new Error("Invalid prompt id"));
    if (!Number.isInteger(index) || index < 0) return Effect.fail(new Error("Invalid image index"));
    const fetcher = this.fetcher;
    const baseUrl = this.baseUrl;
    const readHistory = (): Effect.Effect<unknown, Error> => this.history(promptId);
    return Effect.gen(function* () {
      const images = outputImagesFromHistory(yield* readHistory());
      const selected = images[index];
      if (!selected) return yield* Effect.fail(new Error("Generated image not found"));
      const query = new URLSearchParams({
        filename: selected.filename,
        subfolder: selected.subfolder,
        type: selected.type,
      });
      const response = yield* fetcher(`${baseUrl}/view?${query}`);
      if (!response.ok) {
        return yield* Effect.fail(
          new Error(`ComfyUI image fetch failed with HTTP ${response.status}`),
        );
      }
      const contentType = response.headers.get("content-type") ?? "application/octet-stream";
      if (!contentType.startsWith("image/")) {
        return yield* Effect.fail(new Error("ComfyUI returned a non-image response"));
      }
      const buffer = yield* Effect.tryPromise({
        try: () => response.arrayBuffer(),
        catch: requestError,
      });
      return {
        bytes: new Uint8Array(buffer),
        contentType,
        filename: selected.filename,
      };
    });
  }
}
