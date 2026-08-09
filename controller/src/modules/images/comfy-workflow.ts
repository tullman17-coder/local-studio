export type ComfyWorkflowNode = {
  class_type: string;
  inputs: Record<string, unknown>;
};

export type ComfyWorkflow = Record<string, ComfyWorkflowNode>;

export type ComfyOutputImage = {
  filename: string;
  subfolder: string;
  type: "output";
};

export type SdxlWorkflowInput = {
  checkpoint: string;
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  seed: number;
  steps: number;
  cfg: number;
  count: number;
  filenamePrefix: string;
};

export function buildSdxlWorkflow(input: SdxlWorkflowInput): ComfyWorkflow {
  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: input.checkpoint },
    },
    "2": {
      class_type: "CLIPTextEncode",
      inputs: { text: input.prompt, clip: ["1", 1] },
    },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: { text: input.negativePrompt, clip: ["1", 1] },
    },
    "4": {
      class_type: "EmptyLatentImage",
      inputs: { width: input.width, height: input.height, batch_size: input.count },
    },
    "5": {
      class_type: "KSampler",
      inputs: {
        seed: input.seed,
        steps: input.steps,
        cfg: input.cfg,
        sampler_name: "dpmpp_2m_sde",
        scheduler: "karras",
        denoise: 1,
        model: ["1", 0],
        positive: ["2", 0],
        negative: ["3", 0],
        latent_image: ["4", 0],
      },
    },
    "6": {
      class_type: "VAEDecode",
      inputs: { samples: ["5", 0], vae: ["1", 2] },
    },
    "7": {
      class_type: "SaveImage",
      inputs: { filename_prefix: input.filenamePrefix, images: ["6", 0] },
    },
  };
}

function safePathPart(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("..") &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

function safeSubfolder(value: unknown): value is string {
  if (value === "") return true;
  return (
    typeof value === "string" && !value.includes("..") && value.split(/[\\/]/).every(safePathPart)
  );
}

export function outputImagesFromHistory(history: unknown): ComfyOutputImage[] {
  if (!history || typeof history !== "object" || Array.isArray(history)) return [];
  const outputs = (history as { outputs?: unknown }).outputs;
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) return [];
  return Object.values(outputs as Record<string, unknown>).flatMap((node) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return [];
    const images = (node as { images?: unknown }).images;
    if (!Array.isArray(images)) return [];
    return images.flatMap((image): ComfyOutputImage[] => {
      if (!image || typeof image !== "object" || Array.isArray(image)) return [];
      const candidate = image as { filename?: unknown; subfolder?: unknown; type?: unknown };
      if (
        candidate.type !== "output" ||
        !safePathPart(candidate.filename) ||
        !safeSubfolder(candidate.subfolder)
      ) {
        return [];
      }
      return [
        {
          filename: candidate.filename,
          subfolder: candidate.subfolder,
          type: "output",
        },
      ];
    });
  });
}
