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
  requestTimeoutMs?: number;
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
  Effect.tryPromise({
    try: (signal) => fetch(input, { ...init, signal }),
    catch: requestError,
  });

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const SAFE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function validImageSignature(contentType: string, bytes: Uint8Array): boolean {
  if (contentType === "image/png") {
    return [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  }
  if (contentType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/webp") {
    return new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
      new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
  }
  return false;
}

function boundedResponseBytes(
  response: Response,
  limit: number,
  label: string,
  timeoutMs: number,
): Effect.Effect<Uint8Array, Error> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > limit) {
    return Effect.fail(new Error(`${label} exceeds ${limit} bytes`));
  }
  return Effect.tryPromise({
    try: async (signal) => {
      if (!response.body) return new Uint8Array();
      const reader = response.body.getReader();
      const abort = (): void => { void reader.cancel(); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          total += next.value.byteLength;
          if (total > limit) {
            await reader.cancel();
            throw new Error(`${label} exceeds ${limit} bytes`);
          }
          chunks.push(next.value);
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return bytes;
      } finally {
        signal.removeEventListener("abort", abort);
        reader.releaseLock();
      }
    },
    catch: requestError,
  }).pipe(
    Effect.timeoutOrElse({
      duration: `${timeoutMs} millis`,
      orElse: () => Effect.fail(new Error(`${label} response body timed out`)),
    }),
  );
}

function responseJson(response: Response, timeoutMs: number): Effect.Effect<unknown, Error> {
  if (!response.ok)
    return Effect.fail(new Error(`ComfyUI request failed with HTTP ${response.status}`));
  return boundedResponseBytes(
    response,
    MAX_JSON_BYTES,
    "ComfyUI JSON response",
    timeoutMs,
  ).pipe(
    Effect.flatMap((bytes) =>
      Effect.try({
        try: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
        catch: requestError,
      }),
    ),
  );
}

function historyFailure(history: unknown): string | null {
  if (!history || typeof history !== "object" || Array.isArray(history)) return null;
  const status = (history as { status?: unknown }).status;
  if (!status || typeof status !== "object" || Array.isArray(status)) return null;
  const record = status as { status_str?: unknown; messages?: unknown };
  if (record.status_str !== "error") return null;
  if (Array.isArray(record.messages)) {
    for (const message of [...record.messages].reverse()) {
      if (!Array.isArray(message) || message[0] !== "execution_error") continue;
      const details = message[1];
      if (details && typeof details === "object" && !Array.isArray(details)) {
        const exception = (details as { exception_message?: unknown }).exception_message;
        if (typeof exception === "string" && exception.trim()) return exception.trim().slice(0, 500);
      }
    }
  }
  return "ComfyUI execution failed";
}

export class ComfyClient {
  private readonly baseUrl: string;
  private readonly fetcher: ComfyFetch;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly requestTimeoutMs: number;

  constructor(options: ComfyClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetcher = options.fetcher ?? liveFetch;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.timeoutMs = options.timeoutMs ?? 600_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  private request(input: string | URL | Request, init?: RequestInit): Effect.Effect<Response, Error> {
    return this.fetcher(input, init).pipe(
      Effect.timeoutOrElse({
        duration: `${this.requestTimeoutMs} millis`,
        orElse: () => Effect.fail(new Error("ComfyUI request timed out")),
      }),
    );
  }

  submit(workflow: ComfyWorkflow): Effect.Effect<string, Error> {
    const request = (
      input: string | URL | Request,
      init?: RequestInit,
    ): Effect.Effect<Response, Error> => this.request(input, init);
    const requestTimeoutMs = this.requestTimeoutMs;
    const url = `${this.baseUrl}/prompt`;
    return Effect.gen(function* () {
      const response = yield* request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: workflow }),
      });
      const payload = (yield* responseJson(response, requestTimeoutMs)) as { prompt_id?: unknown };
      if (typeof payload.prompt_id !== "string" || !validPromptId(payload.prompt_id)) {
        return yield* Effect.fail(new Error("ComfyUI returned an invalid prompt id"));
      }
      return payload.prompt_id;
    });
  }

  history(promptId: string): Effect.Effect<unknown, Error> {
    if (!validPromptId(promptId)) return Effect.fail(new Error("Invalid prompt id"));
    return this.request(`${this.baseUrl}/history/${promptId}`).pipe(
      Effect.flatMap((response) => responseJson(response, this.requestTimeoutMs)),
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
        const history = yield* readHistory();
        const failure = historyFailure(history);
        if (failure) return yield* Effect.fail(new Error(failure));
        const images = outputImagesFromHistory(history);
        if (images.length > 0) return images;
        if (pollIntervalMs > 0) yield* Effect.sleep(`${pollIntervalMs} millis`);
      }
      return yield* Effect.fail(new Error(`ComfyUI generation ${promptId} timed out`));
    });
  }

  fetchImage(promptId: string, index: number): Effect.Effect<ComfyImage, Error> {
    if (!validPromptId(promptId)) return Effect.fail(new Error("Invalid prompt id"));
    if (!Number.isInteger(index) || index < 0) return Effect.fail(new Error("Invalid image index"));
    const baseUrl = this.baseUrl;
    const request = (
      input: string | URL | Request,
      init?: RequestInit,
    ): Effect.Effect<Response, Error> => this.request(input, init);
    const requestTimeoutMs = this.requestTimeoutMs;
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
      const response = yield* request(`${baseUrl}/view?${query}`);
      if (!response.ok) {
        return yield* Effect.fail(
          new Error(`ComfyUI image fetch failed with HTTP ${response.status}`),
        );
      }
      const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
      if (!SAFE_IMAGE_TYPES.has(contentType)) {
        return yield* Effect.fail(new Error("ComfyUI returned an unsupported image type"));
      }
      const bytes = yield* boundedResponseBytes(
        response,
        MAX_IMAGE_BYTES,
        "ComfyUI image",
        requestTimeoutMs,
      );
      if (!validImageSignature(contentType, bytes)) {
        return yield* Effect.fail(new Error("ComfyUI returned an invalid image payload"));
      }
      return {
        bytes,
        contentType,
        filename: selected.filename,
      };
    });
  }
}
