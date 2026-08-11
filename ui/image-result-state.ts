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
  resultId?: string;
  createdAt?: string;
  expiresAt?: string;
};

type PersistedImageState = {
  version: 1;
  imageResult: ImageResult;
};

export function getImageResult(value: unknown): ImageResult | undefined {
  const queue: unknown[] = [value];
  const visited = new Set<object>();

  while (queue.length > 0 && visited.size < 24) {
    const candidate = queue.shift();
    if (isImageResult(candidate)) return candidate;
    if (!candidate || typeof candidate !== "object" || visited.has(candidate)) continue;

    visited.add(candidate);
    const record = candidate as Record<string, unknown>;
    for (const key of [
      "structuredContent",
      "privateContent",
      "imageResult",
      "mcp_tool_result",
      "call_tool_result",
      "toolOutput",
      "toolResponseMetadata",
    ]) {
      if (record[key] !== undefined) queue.push(record[key]);
    }
  }

  return undefined;
}

export function getImageResultId(value: unknown): string | undefined {
  const queue: unknown[] = [value];
  const visited = new Set<object>();

  while (queue.length > 0 && visited.size < 24) {
    const candidate = queue.shift();
    if (!candidate || typeof candidate !== "object" || visited.has(candidate)) continue;

    visited.add(candidate);
    const record = candidate as Record<string, unknown>;
    if (typeof record.resultId === "string" && record.resultId.length > 0) return record.resultId;
    for (const key of [
      "structuredContent",
      "privateContent",
      "imageResult",
      "mcp_tool_result",
      "call_tool_result",
      "toolOutput",
      "toolResponseMetadata",
    ]) {
      if (record[key] !== undefined) queue.push(record[key]);
    }
  }

  return undefined;
}

export function getImageResultIdKey(resultId: string): string {
  return `result:${resultId}`;
}

export function getImageResultKey(imageResult: ImageResult): string {
  if (imageResult.resultId) return getImageResultIdKey(imageResult.resultId);
  return `assets:${imageResult.assets.map((asset) => asset.url).join("\n")}`;
}

export function imageResultMatchesBinding(bindingKey: string | undefined, imageResult: ImageResult): boolean {
  return bindingKey === undefined || bindingKey === getImageResultKey(imageResult);
}

export function createPersistedImageState(imageResult: ImageResult) {
  return {
    modelContent: `WJ image result${imageResult.resultId ? ` ${imageResult.resultId}` : ""}: ${imageResult.model}, ${imageResult.assets.length} asset(s).`,
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
