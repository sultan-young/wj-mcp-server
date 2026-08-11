export type ImageAsset = {
  url: string;
  mime_type?: string;
  width?: number;
  height?: number;
};

export type ImageResult = {
  model: string;
  resolution?: string;
  aspectRatio?: string;
  durationMs?: number;
  assets: ImageAsset[];
};

type PersistedImageState = {
  version: 1;
  imageResult: ImageResult;
};

export function getImageResult(value: unknown): ImageResult | undefined {
  if (isImageResult(value)) return value;
  if (!value || typeof value !== "object") return undefined;

  const privateContent = (value as { privateContent?: unknown }).privateContent;
  if (!privateContent || typeof privateContent !== "object") return undefined;

  const state = privateContent as Partial<PersistedImageState>;
  return state.version === 1 && isImageResult(state.imageResult) ? state.imageResult : undefined;
}

export function createPersistedImageState(imageResult: ImageResult) {
  return {
    modelContent: `WJ image result: ${imageResult.model}, ${imageResult.assets.length} asset(s).`,
    privateContent: {
      version: 1 as const,
      imageResult,
    },
  };
}

export function isImageResult(value: unknown): value is ImageResult {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ImageResult>;
  return typeof record.model === "string"
    && Array.isArray(record.assets)
    && record.assets.length > 0
    && record.assets.every((asset) => asset && typeof asset.url === "string" && asset.url.startsWith("https://"));
}
