import { describe, expect, test } from "bun:test";
import { buildSdxlWorkflow, outputImagesFromHistory } from "../src/modules/images/comfy-workflow";

describe("ComfyUI image workflow", () => {
  test("builds a bounded SDXL text-to-image graph", () => {
    const workflow = buildSdxlWorkflow({
      checkpoint: "ponyDiffusionV6XL_v6StartWithThisOne.safetensors",
      prompt: "a lighthouse during a violet storm",
      negativePrompt: "blurry",
      width: 832,
      height: 1216,
      seed: 42,
      steps: 28,
      cfg: 7,
      count: 2,
      filenamePrefix: "local-studio/test",
    });

    expect(workflow["1"]?.inputs["ckpt_name"]).toBe(
      "ponyDiffusionV6XL_v6StartWithThisOne.safetensors",
    );
    expect(workflow["2"]?.inputs["text"]).toBe("a lighthouse during a violet storm");
    expect(workflow["3"]?.inputs["text"]).toBe("blurry");
    expect(workflow["4"]?.inputs).toMatchObject({ width: 832, height: 1216, batch_size: 2 });
    expect(workflow["5"]?.inputs).toMatchObject({ seed: 42, steps: 28, cfg: 7 });
    expect(workflow["7"]?.inputs["filename_prefix"]).toBe("local-studio/test");
  });

  test("extracts only safe output image references", () => {
    const outputs = outputImagesFromHistory({
      outputs: {
        "7": {
          images: [
            { filename: "local-studio_00001_.png", subfolder: "local-studio", type: "output" },
            {
              filename: "image_00002_.png",
              subfolder: "local-studio\\2026-08-09",
              type: "output",
            },
            { filename: "../secret.png", subfolder: "", type: "output" },
            { filename: "preview.png", subfolder: "", type: "temp" },
          ],
        },
      },
    });

    expect(outputs).toEqual([
      { filename: "local-studio_00001_.png", subfolder: "local-studio", type: "output" },
      {
        filename: "image_00002_.png",
        subfolder: "local-studio\\2026-08-09",
        type: "output",
      },
    ]);
  });

  test("ignores active-content and header-injection filenames from history", () => {
    const outputs = outputImagesFromHistory({
      outputs: {
        node: {
          images: [
            { filename: "evil.svg", subfolder: "", type: "output" },
            { filename: "line\r\nX-Evil.png", subfolder: "", type: "output" },
            { filename: "emoji-💣.png", subfolder: "", type: "output" },
            { filename: "safe.webp", subfolder: "local-studio", type: "output" },
          ],
        },
      },
    });
    expect(outputs).toEqual([
      { filename: "safe.webp", subfolder: "local-studio", type: "output" },
    ]);
  });
});
