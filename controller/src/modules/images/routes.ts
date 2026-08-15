import { Effect } from "effect";
import type { Config } from "../../config/env";
import type { Logger } from "../../core/logger";
import { effectHandler } from "../../http/effect-handler";
import { readBoundedRequestBody } from "../../http/bounded-body";
import { documentRoute, mergeRoutes, type ControllerRouteApp } from "../../http/route-registrar";
import { ComfyClient } from "./comfy-client";
import { buildComfyWorkflow } from "./comfy-workflow";

const DEFAULT_CHECKPOINT = "flux-2-klein-4b-nvfp4.safetensors";
const NSFW_CHECKPOINT = "ponyDiffusionV6XL_v6StartWithThisOne.safetensors";
const DEFAULT_NEGATIVE = "low quality, blurry, malformed, watermark, text";
const MAX_IMAGE_REQUEST_BYTES = 16 * 1024;
const NSFW_MINOR_TERMS =
  /\b(?:minor(?:s)?|underage|child(?:ren)?|kid(?:s)?|teen(?:s|ager|agers)?|schoolgirl(?:s)?|schoolboy(?:s)?|baby|babies|toddler(?:s)?)\b|\b(?:little|young)[\s-]+(?:girl|boy)(?:s)?\b/i;

type GenerationInput = {
  prompt: string;
  nsfw?: boolean;
  negative_prompt?: string;
  model?: string;
  n?: number;
  size?: string;
  seed?: number;
  steps?: number;
  cfg_scale?: number;
};

type ImageRoutesContext = {
  config: Pick<Config, "comfyui_url" | "comfyui_checkpoint" | "comfyui_output_prefix">;
  logger: Pick<Logger, "error">;
};

function integer(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`Expected an integer from ${minimum} to ${maximum}`);
  }
  return Number(value);
}

function decimal(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < minimum || numeric > maximum) {
    throw new Error(`Expected a number from ${minimum} to ${maximum}`);
  }
  return numeric;
}

function imageSize(value: unknown): { width: number; height: number } {
  const size = typeof value === "string" && value.trim() ? value.trim() : "1024x1024";
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(size);
  if (!match) throw new Error("Size must use WIDTHxHEIGHT");
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (
    width < 512 ||
    width > 1536 ||
    height < 512 ||
    height > 1536 ||
    width % 64 !== 0 ||
    height % 64 !== 0
  ) {
    throw new Error("Image dimensions must be 512–1536 pixels and divisible by 64");
  }
  return { width, height };
}

function generationInput(value: unknown): GenerationInput & { prompt: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("A JSON request body is required");
  }
  const input = value as GenerationInput;
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt || prompt.length > 4_000) throw new Error("Prompt must be 1 to 4000 characters");
  if (
    input.negative_prompt !== undefined &&
    (typeof input.negative_prompt !== "string" || input.negative_prompt.length > 2_000)
  ) {
    throw new Error("Negative prompt must be a string of 2000 characters or fewer");
  }
  if (input.nsfw !== undefined && typeof input.nsfw !== "boolean") {
    throw new Error("NSFW mode must be a boolean");
  }
  if (input.nsfw && NSFW_MINOR_TERMS.test(prompt)) {
    throw new Error("Prompt is not allowed");
  }
  return { ...input, prompt };
}

function imageClient(context: ImageRoutesContext): ComfyClient | null {
  return context.config.comfyui_url
    ? new ComfyClient({ baseUrl: context.config.comfyui_url })
    : null;
}

function unavailable(): Response {
  return Response.json(
    { error: { code: "image_backend_unconfigured", message: "ComfyUI is not configured" } },
    { status: 503 },
  );
}

function failure(context: ImageRoutesContext, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  const invalid =
    message.startsWith("Prompt ") ||
    message.startsWith("Negative ") ||
    message.startsWith("Size ") ||
    message.startsWith("Image dimensions") ||
    message.startsWith("NSFW ") ||
    message.startsWith("Expected ") ||
    message.startsWith("A JSON");
  const invalidRequest = invalid || message.startsWith("Request body exceeds");
  if (!invalidRequest) context.logger.error("image generation route failed", { error: message });
  return Response.json(
    {
      error: {
        code: invalidRequest ? "invalid_image_request" : "image_generation_failed",
        message: invalidRequest ? message : "Image generation failed",
      },
    },
    { status: invalidRequest ? 400 : 502 },
  );
}

export function registerImageRoutes(
  app: ControllerRouteApp,
  context: ImageRoutesContext,
): ControllerRouteApp {
  return mergeRoutes(
    app.post(
      "/v1/images/generations",
      documentRoute,
      effectHandler((ctx) => {
        const client = imageClient(context);
        if (!client) return Effect.succeed(unavailable());
        return Effect.gen(function* () {
          const bytes = yield* readBoundedRequestBody(ctx.req.raw, MAX_IMAGE_REQUEST_BYTES);
          const body = yield* Effect.try({
            try: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
            catch: () => new Error("A JSON request body is required"),
          });
          const input = yield* Effect.try({
            try: () => generationInput(body),
            catch: (error) => error,
          });
          const { width, height } = imageSize(input.size);
          const checkpoint = input.nsfw
            ? NSFW_CHECKPOINT
            : (context.config.comfyui_checkpoint ?? DEFAULT_CHECKPOINT);
          if (input.model && input.model !== checkpoint) {
            return Response.json(
              {
                error: {
                  code: "image_model_unavailable",
                  message: `Configured image model is ${checkpoint}`,
                },
              },
              { status: 400 },
            );
          }
          const created = Math.floor(Date.now() / 1_000);
          const folder = new Date().toISOString().slice(0, 10);
          const isFlux2Klein = checkpoint.toLowerCase().includes("flux-2-klein");
          const workflow = buildComfyWorkflow({
            model: checkpoint,
            prompt: input.prompt,
            negativePrompt: input.negative_prompt?.trim() || DEFAULT_NEGATIVE,
            width,
            height,
            seed: integer(
              input.seed,
              crypto.getRandomValues(new Uint32Array(1))[0] ?? 0,
              0,
              2 ** 32 - 1,
            ),
            steps: integer(input.steps, isFlux2Klein ? 4 : 28, 1, 60),
            cfg: decimal(input.cfg_scale, isFlux2Klein ? 1 : 7, 1, 20),
            count: integer(input.n, 1, 1, 4),
            filenamePrefix: `${context.config.comfyui_output_prefix}/${folder}/image`,
          });
          const promptId = yield* client.submit(workflow);
          const images = yield* client.waitForImages(promptId);
          return Response.json({
            created,
            prompt_id: promptId,
            data: images.map((_, index) => ({
              url: `/v1/images/files/${promptId}/${index}`,
              revised_prompt: input.prompt,
            })),
          });
        }).pipe(Effect.catch((error) => Effect.succeed(failure(context, error))));
      }),
    ),
    app.get(
      "/v1/images/files/:promptId/:index",
      documentRoute,
      effectHandler((ctx) => {
        const client = imageClient(context);
        if (!client) return Effect.succeed(unavailable());
        const promptId = ctx.req.param("promptId");
        if (!promptId) return Effect.succeed(failure(context, new Error("Invalid prompt id")));
        return client.fetchImage(promptId, Number(ctx.req.param("index"))).pipe(
          Effect.map((image) => {
            const body = image.bytes.slice().buffer as ArrayBuffer;
            return new Response(body, {
              headers: {
                "content-type": image.contentType,
                "content-disposition": `inline; filename="${image.filename.replaceAll('"', "")}"`,
                "cache-control": "private, max-age=31536000, immutable",
                "x-content-type-options": "nosniff",
                "content-security-policy": "default-src 'none'; sandbox",
              },
            });
          }),
          Effect.catch((error) => Effect.succeed(failure(context, error))),
        );
      }),
    ),
  );
}
