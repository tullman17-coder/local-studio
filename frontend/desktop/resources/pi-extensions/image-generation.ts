import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

type GenerationResponse = {
  prompt_id?: string;
  data?: Array<{ url?: string; revised_prompt?: string }>;
  error?: { message?: string };
};

const FRONTEND_BASE = process.env.LOCAL_STUDIO_FRONTEND_BASE ?? "http://127.0.0.1:3000";
const GENERATION_TIMEOUT_MS = 600_000;
const SIZE_BY_RATIO = {
  square: "1024x1024",
  portrait: "832x1216",
  landscape: "1216x832",
} as const;

function result(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text }], details };
}

export function generationPreviewUrl(controllerUrl: string): string {
  if (!/^\/v1\/images\/files\/[A-Za-z0-9_-]+\/\d+$/.test(controllerUrl)) {
    throw new Error("Invalid image URL returned by Local Studio");
  }
  return `/api/proxy${controllerUrl}`;
}

export default function registerImageGenerationExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "generate_image",
    label: "Generate image",
    description:
      "Generate an image on the configured private ComfyUI server. Use this whenever the user asks you to create, draw, render, illustrate, or generate an image. The result is surfaced inline in this chat automatically.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Detailed positive visual prompt" }),
      negativePrompt: Type.Optional(
        Type.String({ description: "Elements, defects, or styles to avoid" }),
      ),
      aspectRatio: Type.Optional(
        Type.Union([Type.Literal("square"), Type.Literal("portrait"), Type.Literal("landscape")], {
          description: "Output shape; defaults to square",
        }),
      ),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
      seed: Type.Optional(Type.Integer({ minimum: 0, maximum: 4_294_967_295 })),
      steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
      cfgScale: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
    }),
    async execute(_id, params, signal) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) controller.abort();
      try {
        const ratio = params.aspectRatio ?? "square";
        const response = await fetch(`${FRONTEND_BASE}/api/proxy/v1/images/generations`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompt: params.prompt,
            negative_prompt: params.negativePrompt,
            n: params.count ?? 1,
            size: SIZE_BY_RATIO[ratio],
            seed: params.seed,
            steps: params.steps,
            cfg_scale: params.cfgScale,
          }),
          signal: controller.signal,
        });
        const payload = (await response.json()) as GenerationResponse;
        if (!response.ok) {
          throw new Error(payload.error?.message ?? `HTTP ${response.status}`);
        }
        const images = (payload.data ?? []).map((image) => ({
          url: generationPreviewUrl(image.url ?? ""),
          prompt: image.revised_prompt ?? params.prompt,
        }));
        if (images.length === 0) throw new Error("Local Studio returned no generated images");
        const details = {
          kind: "generated-image",
          promptId: payload.prompt_id ?? null,
          images,
        };
        return result(JSON.stringify(details), details);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return result(`Image generation failed: ${message}`, { failed: true, error: message });
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      }
    },
  });
}
