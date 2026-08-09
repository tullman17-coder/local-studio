export type GeneratedImageResult = {
  url: string;
  prompt: string;
};

const GENERATED_IMAGE_PATH = /^\/api\/proxy\/v1\/images\/files\/[A-Za-z0-9_-]+\/\d+$/;

export function generatedImagesFromToolResult(
  value: string | null | undefined,
): GeneratedImageResult[] {
  if (!value) return [];
  try {
    const payload = JSON.parse(value) as {
      kind?: unknown;
      images?: Array<{ url?: unknown; prompt?: unknown }>;
    };
    if (payload.kind !== "generated-image" || !Array.isArray(payload.images)) return [];
    return payload.images.flatMap((image) => {
      if (typeof image.url !== "string" || !GENERATED_IMAGE_PATH.test(image.url)) return [];
      return [
        {
          url: image.url,
          prompt: typeof image.prompt === "string" ? image.prompt : "Generated image",
        },
      ];
    });
  } catch {
    return [];
  }
}
