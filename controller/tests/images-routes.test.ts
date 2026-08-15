import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createControllerRuntime } from "../src/core/effect-runtime";
import { controllerRuntimeMiddleware, type ControllerEnvironment } from "../src/http/effect-handler";
import { registerImageRoutes } from "../src/modules/images/routes";

const NSFW_CHECKPOINT = "ponyDiffusionV6XL_v6StartWithThisOne.safetensors";
const NSFW_REALISTIC_CHECKPOINT = "flux1-dev-fp8.safetensors";
const SAFE_CHECKPOINT = "flux-2-klein-4b-nvfp4.safetensors";
const ADULT_ASSERTION = "All depicted people are consenting adults age 18 or older.";
const originalFetch = globalThis.fetch;
const runtime = createControllerRuntime();
const submittedWorkflows: Record<string, unknown>[] = [];
let fetchCalls = 0;

const app = new Hono<ControllerEnvironment>();
app.use("*", controllerRuntimeMiddleware(runtime));
registerImageRoutes(app, {
  config: {
    comfyui_url: "http://comfy.test",
    comfyui_checkpoint: SAFE_CHECKPOINT,
    comfyui_output_prefix: "local-studio",
  },
  logger: { error: () => undefined },
});

beforeEach(() => {
  submittedWorkflows.length = 0;
  fetchCalls = 0;
  globalThis.fetch = (async (input, init) => {
    fetchCalls += 1;
    const url = String(input);
    if (url.endsWith("/prompt")) {
      const payload = JSON.parse(String(init?.body)) as { prompt: Record<string, unknown> };
      submittedWorkflows.push(payload.prompt);
      return Response.json({ prompt_id: "prompt-1" });
    }
    if (url.endsWith("/history/prompt-1")) {
      return Response.json({
        "prompt-1": {
          outputs: {
            "7": {
              images: [{ filename: "image.png", subfolder: "", type: "output" }],
            },
          },
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await runtime.dispose();
});

async function generate(body: Record<string, unknown>): Promise<Response> {
  return app.request("/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/images/generations NSFW mode", () => {
  test("rejects a non-boolean NSFW mode as an invalid request", async () => {
    const response = await generate({ prompt: "an adult portrait", nsfw: "true" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_image_request", message: "NSFW mode must be a boolean" },
    });
    expect(fetchCalls).toBe(0);
  });

  test("trusts ordinary local adult prompts without requiring a magic assertion", async () => {
    for (const prompt of [
      "a boudoir portrait of an adult",
      "a young woman in her twenties",
      "an adult student portrait",
    ]) {
      const response = await generate({ prompt, nsfw: true });
      expect(response.status).toBe(200);
    }
    expect(fetchCalls).toBe(6);
  });

  test("accepts 18+ and numeric adult-age affirmations", async () => {
    for (const prompt of [
      `${ADULT_ASSERTION} an 18+ boudoir portrait`,
      `${ADULT_ASSERTION} a 27-year-old model in a private studio`,
      `${ADULT_ASSERTION} a model age 18 in a private studio`,
      `${ADULT_ASSERTION} a 22 y/o model in a private studio`,
    ]) {
      const response = await generate({ prompt, nsfw: true });
      expect(response.status).toBe(200);
    }
    expect(fetchCalls).toBe(8);
  });

  test("rejects every numeric age below 18 even with an adult affirmation", async () => {
    for (const prompt of [
      `${ADULT_ASSERTION} a 17-year-old adult`,
      `${ADULT_ASSERTION} an adult, age 9`,
      `${ADULT_ASSERTION} an adult 0 years old`,
      `${ADULT_ASSERTION} a 17 years-old model`,
      `${ADULT_ASSERTION} a 17 yrs old model`,
      `${ADULT_ASSERTION} a seventeen-year-old model`,
      `${ADULT_ASSERTION} a 17 y.o. model`,
      `${ADULT_ASSERTION} a seventeen y/o model`,
      `${ADULT_ASSERTION} a subject under 18`,
      `${ADULT_ASSERTION} a subject under eighteen`,
      `${ADULT_ASSERTION} a 16yo model`,
      `${ADULT_ASSERTION} a model age seventeen`,
      `${ADULT_ASSERTION} a subject below 18`,
      `${ADULT_ASSERTION} a subject not yet 18`,
    ]) {
      const response = await generate({ prompt, nsfw: true });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: "invalid_image_request", message: "Prompt is not allowed" },
      });
    }
    expect(fetchCalls).toBe(0);
  });

  test("rejects explicit minor intent but not broad adult style vocabulary", async () => {
    const prohibitedTerms = [
      "minor",
      "underage",
      "child",
      "kid",
      "teen",
      "schoolgirl",
      "schoolboy",
      "baby",
      "toddler",
      "preteen",
      "pre teen",
      "pre-teen",
      "adolescent",
      "infant",
      "newborn",
      "new born",
      "new-born",
      "loli",
      "lolita",
      "lolicon",
      "shota",
      "shotacon",
      "barely legal",
      "just turned 18",
    ];

    for (const term of prohibitedTerms) {
      const response = await generate({ prompt: `${ADULT_ASSERTION} portrait of a ${term}`, nsfw: true });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: "invalid_image_request", message: "Prompt is not allowed" },
      });
    }
    expect(fetchCalls).toBe(0);
  });

  test("hot-swaps the allowlisted NSFW checkpoint by style", async () => {
    const realistic = await generate({
      prompt: "an adult editorial portrait",
      nsfw: true,
      nsfw_style: "realistic",
    });
    expect(realistic.status).toBe(200);
    expect(submittedWorkflows[0]!["1"]).toEqual({
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: NSFW_REALISTIC_CHECKPOINT },
    });

    const illustrated = await generate({
      prompt: "an adult anime illustration",
      nsfw: true,
      nsfw_style: "illustrated",
    });
    expect(illustrated.status).toBe(200);
    expect(submittedWorkflows[1]!["1"]).toEqual({
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: NSFW_CHECKPOINT },
    });
  });

  test("rejects unknown NSFW styles before contacting ComfyUI", async () => {
    const response = await generate({
      prompt: "an adult portrait",
      nsfw: true,
      nsfw_style: "custom-model",
    });
    expect(response.status).toBe(400);
    expect(fetchCalls).toBe(0);
  });

  test("keeps safe mode on the configured Flux2 checkpoint", async () => {
    const response = await generate({
      prompt: "a children's book illustration",
      nsfw: false,
      model: SAFE_CHECKPOINT,
    });

    expect(response.status).toBe(200);
    expect(submittedWorkflows[0]!["1"]).toEqual({
      class_type: "UNETLoader",
      inputs: { unet_name: SAFE_CHECKPOINT, weight_dtype: "default" },
    });
  });

  test("requires a supplied model to match the checkpoint selected by the mode", async () => {
    for (const body of [
      { prompt: `${ADULT_ASSERTION} an adult portrait`, nsfw: true, model: SAFE_CHECKPOINT },
      { prompt: "a landscape", nsfw: false, model: NSFW_CHECKPOINT },
    ]) {
      const response = await generate(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "image_model_unavailable" },
      });
    }
    expect(fetchCalls).toBe(0);
  });

  test("uses the SDXL negative prompt and defaults for an ordinary adult NSFW prompt", async () => {
    const response = await generate({ prompt: `${ADULT_ASSERTION} an adult boudoir portrait`, nsfw: true });

    expect(response.status).toBe(200);
    expect(submittedWorkflows[0]!["3"]).toEqual({
      class_type: "CLIPTextEncode",
      inputs: {
        text: "low quality, blurry, malformed, watermark, text",
        clip: ["1", 1],
      },
    });
    expect(submittedWorkflows[0]!["5"]).toMatchObject({
      class_type: "KSampler",
      inputs: { steps: 28, cfg: 7 },
    });
  });

  test("routes NSFW generation to the allowlisted SDXL checkpoint and preserves caller settings", async () => {
    const response = await generate({
      prompt: `${ADULT_ASSERTION} an adult couple in a private studio`,
      negative_prompt: "custom negative",
      nsfw: true,
      model: NSFW_CHECKPOINT,
      size: "832x1216",
      seed: 42,
      steps: 33,
      cfg_scale: 8.5,
      n: 2,
    });

    expect(response.status).toBe(200);
    const workflow = submittedWorkflows[0]!;
    expect(workflow["1"]).toEqual({
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: NSFW_CHECKPOINT },
    });
    expect(workflow["2"]).toEqual({
      class_type: "CLIPTextEncode",
      inputs: { text: `${ADULT_ASSERTION} an adult couple in a private studio`, clip: ["1", 1] },
    });
    expect(workflow["3"]).toEqual({
      class_type: "CLIPTextEncode",
      inputs: { text: "custom negative", clip: ["1", 1] },
    });
    expect(workflow["4"]).toEqual({
      class_type: "EmptyLatentImage",
      inputs: { width: 832, height: 1216, batch_size: 2 },
    });
    expect(workflow["5"]).toMatchObject({
      class_type: "KSampler",
      inputs: { seed: 42, steps: 33, cfg: 8.5 },
    });
  });
});
