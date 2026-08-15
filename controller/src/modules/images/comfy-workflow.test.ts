import { describe, expect, test } from "bun:test";
import { buildComfyWorkflow, buildFlux2KleinWorkflow } from "./comfy-workflow";

describe("buildFlux2KleinWorkflow", () => {
  test("builds the installed distilled Klein graph for the Boop worker", () => {
    const workflow = buildFlux2KleinWorkflow({
      diffusionModel: "flux-2-klein-4b-nvfp4.safetensors",
      textEncoder: "qwen_3_4b_fp4_flux2.safetensors",
      vae: "flux2-vae.safetensors",
      prompt: "a brass robot",
      width: 768,
      height: 512,
      seed: 42,
      steps: 4,
      cfg: 1,
      count: 2,
      filenamePrefix: "local-studio/2026-08-09/image",
    });

    expect(workflow["1"]).toEqual({
      class_type: "UNETLoader",
      inputs: {
        unet_name: "flux-2-klein-4b-nvfp4.safetensors",
        weight_dtype: "default",
      },
    });
    expect(workflow["2"]?.inputs).toEqual({
      clip_name: "qwen_3_4b_fp4_flux2.safetensors",
      type: "flux2",
      device: "default",
    });
    expect(workflow["3"]?.inputs).toEqual({ vae_name: "flux2-vae.safetensors" });
    expect(workflow["4"]?.inputs).toEqual({ clip: ["2", 0], text: "a brass robot" });
    expect(workflow["5"]).toEqual({
      class_type: "ConditioningZeroOut",
      inputs: { conditioning: ["4", 0] },
    });
    expect(workflow["6"]?.inputs).toMatchObject({ cfg: 1 });
    expect(workflow["7"]?.inputs).toEqual({ noise_seed: 42 });
    expect(workflow["9"]?.inputs).toEqual({ steps: 4, width: 768, height: 512 });
    expect(workflow["10"]?.inputs).toEqual({ width: 768, height: 512, batch_size: 2 });
    expect(workflow["13"]?.inputs).toEqual({
      images: ["12", 0],
      filename_prefix: "local-studio/2026-08-09/image",
    });
  });
});

describe("buildComfyWorkflow", () => {
  const base = {
    prompt: "test",
    negativePrompt: "bad",
    width: 512,
    height: 512,
    seed: 7,
    steps: 4,
    cfg: 1,
    count: 1,
    filenamePrefix: "local-studio/test",
  };

  test("selects the installed Flux2 Klein graph by model name", () => {
    const workflow = buildComfyWorkflow({
      ...base,
      model: "flux-2-klein-4b-nvfp4.safetensors",
    });

    expect(workflow["1"]?.class_type).toBe("UNETLoader");
    expect(workflow["2"]?.inputs["clip_name"]).toBe("qwen_3_4b_fp4_flux2.safetensors");
    expect(workflow["3"]?.inputs["vae_name"]).toBe("flux2-vae.safetensors");
  });

  test("builds the allowlisted Pony checkpoint with the SDXL negative conditioning", () => {
    const workflow = buildComfyWorkflow({
      ...base,
      model: "ponyDiffusionV6XL_v6StartWithThisOne.safetensors",
      negativePrompt: "custom negative",
      width: 832,
      height: 1216,
      seed: 42,
      steps: 33,
      cfg: 8.5,
      count: 2,
    });

    expect(workflow["1"]?.class_type).toBe("CheckpointLoaderSimple");
    expect(workflow["1"]?.inputs["ckpt_name"]).toBe(
      "ponyDiffusionV6XL_v6StartWithThisOne.safetensors",
    );
    expect(workflow["3"]?.inputs["text"]).toBe("custom negative");
    expect(workflow["4"]?.inputs).toEqual({ width: 832, height: 1216, batch_size: 2 });
    expect(workflow["5"]?.inputs).toMatchObject({ seed: 42, steps: 33, cfg: 8.5 });
  });

  test("keeps an SDXL checkpoint on the checkpoint workflow", () => {
    const workflow = buildComfyWorkflow({
      ...base,
      model: "ponyDiffusionV6XL_v6StartWithThisOne.safetensors",
    });

    expect(workflow["1"]?.class_type).toBe("CheckpointLoaderSimple");
    expect(workflow["1"]?.inputs["ckpt_name"]).toBe(
      "ponyDiffusionV6XL_v6StartWithThisOne.safetensors",
    );
  });
});
