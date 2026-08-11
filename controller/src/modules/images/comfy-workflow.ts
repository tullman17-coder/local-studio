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

export type Flux2KleinWorkflowInput = {
  diffusionModel: string;
  textEncoder: string;
  vae: string;
  prompt: string;
  width: number;
  height: number;
  seed: number;
  steps: number;
  cfg: number;
  count: number;
  filenamePrefix: string;
};

export type ComfyWorkflowInput = Omit<SdxlWorkflowInput, "checkpoint"> & {
  model: string;
};

export const FLUX2_KLEIN_TEXT_ENCODER = "qwen_3_4b_fp4_flux2.safetensors";
export const FLUX2_VAE = "flux2-vae.safetensors";

export function buildComfyWorkflow(input: ComfyWorkflowInput): ComfyWorkflow {
  if (input.model.toLowerCase().includes("flux-2-klein")) {
    return buildFlux2KleinWorkflow({
      diffusionModel: input.model,
      textEncoder: FLUX2_KLEIN_TEXT_ENCODER,
      vae: FLUX2_VAE,
      prompt: input.prompt,
      width: input.width,
      height: input.height,
      seed: input.seed,
      steps: input.steps,
      cfg: input.cfg,
      count: input.count,
      filenamePrefix: input.filenamePrefix,
    });
  }

  return buildSdxlWorkflow({
    checkpoint: input.model,
    prompt: input.prompt,
    negativePrompt: input.negativePrompt,
    width: input.width,
    height: input.height,
    seed: input.seed,
    steps: input.steps,
    cfg: input.cfg,
    count: input.count,
    filenamePrefix: input.filenamePrefix,
  });
}

export function buildFlux2KleinWorkflow(input: Flux2KleinWorkflowInput): ComfyWorkflow {
  return {
    "1": {
      class_type: "UNETLoader",
      inputs: { unet_name: input.diffusionModel, weight_dtype: "default" },
    },
    "2": {
      class_type: "CLIPLoader",
      inputs: { clip_name: input.textEncoder, type: "flux2", device: "default" },
    },
    "3": {
      class_type: "VAELoader",
      inputs: { vae_name: input.vae },
    },
    "4": {
      class_type: "CLIPTextEncode",
      inputs: { clip: ["2", 0], text: input.prompt },
    },
    "5": {
      class_type: "ConditioningZeroOut",
      inputs: { conditioning: ["4", 0] },
    },
    "6": {
      class_type: "CFGGuider",
      inputs: {
        model: ["1", 0],
        positive: ["4", 0],
        negative: ["5", 0],
        cfg: input.cfg,
      },
    },
    "7": {
      class_type: "RandomNoise",
      inputs: { noise_seed: input.seed },
    },
    "8": {
      class_type: "KSamplerSelect",
      inputs: { sampler_name: "euler" },
    },
    "9": {
      class_type: "Flux2Scheduler",
      inputs: { steps: input.steps, width: input.width, height: input.height },
    },
    "10": {
      class_type: "EmptyFlux2LatentImage",
      inputs: { width: input.width, height: input.height, batch_size: input.count },
    },
    "11": {
      class_type: "SamplerCustomAdvanced",
      inputs: {
        noise: ["7", 0],
        guider: ["6", 0],
        sampler: ["8", 0],
        sigmas: ["9", 0],
        latent_image: ["10", 0],
      },
    },
    "12": {
      class_type: "VAEDecode",
      inputs: { samples: ["11", 0], vae: ["3", 0] },
    },
    "13": {
      class_type: "SaveImage",
      inputs: { images: ["12", 0], filename_prefix: input.filenamePrefix },
    },
  };
}

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
    /^[A-Za-z0-9._ -]+$/.test(value) &&
    !value.includes("..") &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function safeOutputFilename(value: unknown): value is string {
  return (
    safePathPart(value) &&
    value.length <= 255 &&
    /\.(?:png|jpe?g|webp)$/i.test(value)
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
        !safeOutputFilename(candidate.filename) ||
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
