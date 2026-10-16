/**
 * 生图可选项，与 wj-ai-server `image-model.config` 的 resolutions / aspect_ratios 对齐。
 * 默认模型、默认比例、以及 gpt-image-2 / nano-banana-2 的默认分辨率不在这里改。
 */

export const IMAGE_MODEL_IDS = [
  "gpt-image-2",
  "nano-banana-2",
  "gpt-image-2.5",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
] as const;

export type ImageModelId = (typeof IMAGE_MODEL_IDS)[number];

export const ALL_RESOLUTIONS = ["512", "1K", "2K", "4K"] as const;
export type ImageResolution = (typeof ALL_RESOLUTIONS)[number];

/** gpt-image-2 / flare / sunburst，与 wj-ai-server GPT_IMAGE_ASPECT_RATIOS 一致 */
const GPT_IMAGE_ASPECT_RATIOS = [
  "auto",
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "5:4",
  "4:5",
  "21:9",
  "9:21",
  "1:3",
  "3:1",
  "2:1",
  "1:2",
] as const;

/** gpt-image-2.5 只有 1K 像素表，不含 vip 独有的 1:3 / 3:1 */
const GPT_IMAGE_25_ASPECT_RATIOS = [
  "auto",
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "5:4",
  "4:5",
  "21:9",
  "9:21",
  "1:2",
  "2:1",
] as const;

/** nano-banana-2，与 wj-ai-server NANO_BANANA_2_ASPECT_RATIOS 一致 */
const NANO_BANANA_2_ASPECT_RATIOS = [
  "auto",
  "1:1",
  "1:4",
  "1:8",
  "2:3",
  "3:2",
  "3:4",
  "4:1",
  "4:3",
  "4:5",
  "5:4",
  "8:1",
  "9:16",
  "16:9",
  "21:9",
] as const;

export const ALL_ASPECT_RATIOS = [
  ...GPT_IMAGE_ASPECT_RATIOS,
  "1:4",
  "1:8",
  "4:1",
  "8:1",
] as const;

export type ImageAspectRatio = (typeof ALL_ASPECT_RATIOS)[number];

export interface ImageModelOptions {
  resolutions: readonly ImageResolution[];
  aspectRatios: readonly ImageAspectRatio[];
  defaultResolution: ImageResolution;
}

export const IMAGE_MODEL_CATALOG: Record<ImageModelId, ImageModelOptions> = {
  "gpt-image-2": {
    resolutions: ["1K", "2K", "4K"],
    aspectRatios: GPT_IMAGE_ASPECT_RATIOS,
    defaultResolution: "1K",
  },
  "nano-banana-2": {
    resolutions: ["512", "1K", "2K", "4K"],
    aspectRatios: NANO_BANANA_2_ASPECT_RATIOS,
    defaultResolution: "2K",
  },
  "gpt-image-2.5": {
    resolutions: ["1K"],
    aspectRatios: GPT_IMAGE_25_ASPECT_RATIOS,
    defaultResolution: "1K",
  },
  "gpt-image-2.5-flare": {
    resolutions: ["1K", "2K", "4K"],
    aspectRatios: GPT_IMAGE_ASPECT_RATIOS,
    defaultResolution: "1K",
  },
  "gpt-image-2.5-sunburst": {
    resolutions: ["1K", "2K", "4K"],
    aspectRatios: GPT_IMAGE_ASPECT_RATIOS,
    defaultResolution: "1K",
  },
};

export function isImageModelId(value: string): value is ImageModelId {
  return (IMAGE_MODEL_IDS as readonly string[]).includes(value);
}

export function defaultResolutionForModel(model: ImageModelId): ImageResolution {
  return IMAGE_MODEL_CATALOG[model].defaultResolution;
}

export function imageModelOptionSummary(): string {
  return IMAGE_MODEL_IDS.map((model) => {
    const options = IMAGE_MODEL_CATALOG[model];
    return `${model}: resolutions ${options.resolutions.join("/")} (default ${options.defaultResolution}); aspect ratios ${options.aspectRatios.join(", ")}`;
  }).join(". ");
}

export function validateModelImageOptions(
  model: ImageModelId,
  aspectRatio: string,
  resolution: string | undefined,
): Array<{ path: "aspect_ratio" | "resolution"; message: string }> {
  const options = IMAGE_MODEL_CATALOG[model];
  const issues: Array<{ path: "aspect_ratio" | "resolution"; message: string }> = [];
  if (!(options.aspectRatios as readonly string[]).includes(aspectRatio)) {
    issues.push({
      path: "aspect_ratio",
      message: `aspect_ratio ${aspectRatio} is not supported for ${model}; allowed: ${options.aspectRatios.join(", ")}`,
    });
  }
  if (resolution !== undefined && !(options.resolutions as readonly string[]).includes(resolution)) {
    issues.push({
      path: "resolution",
      message: `resolution ${resolution} is not supported for ${model}; allowed: ${options.resolutions.join(", ")}`,
    });
  }
  return issues;
}
