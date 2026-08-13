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

export type ImageJob = {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed" | "timed_out";
  model: string;
  resolution?: string;
  aspectRatio?: string;
  durationMs?: number;
  assets: ImageAsset[];
  resultId?: string;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
  expiresAt?: string;
};

type PersistedImageState = {
  version: 1;
  imageResult: ImageResult;
} | {
  version: 2;
  jobId: string;
  imageResult?: ImageResult;
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

export function getImageJob(value: unknown): ImageJob | undefined {
  const queue: unknown[] = [value];
  const visited = new Set<object>();

  while (queue.length > 0 && visited.size < 24) {
    const candidate = queue.shift();
    if (isImageJob(candidate)) return candidate;
    if (!candidate || typeof candidate !== "object" || visited.has(candidate)) continue;

    visited.add(candidate);
    const record = candidate as Record<string, unknown>;
    for (const key of [
      "structuredContent",
      "privateContent",
      "imageJob",
      "mcp_tool_result",
      "call_tool_result",
      "toolOutput",
      "toolResponseMetadata",
      "_meta",
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

export function getImageJobId(value: unknown): string | undefined {
  const job = getImageJob(value);
  if (job?.jobId) return job.jobId;
  const queue: unknown[] = [value];
  const visited = new Set<object>();
  while (queue.length > 0 && visited.size < 24) {
    const candidate = queue.shift();
    if (!candidate || typeof candidate !== "object" || visited.has(candidate)) continue;
    visited.add(candidate);
    const record = candidate as Record<string, unknown>;
    if (typeof record.jobId === "string" && record.jobId.length > 0) return record.jobId;
    for (const key of ["structuredContent", "privateContent", "_meta", "toolOutput", "toolResponseMetadata"]) {
      if (record[key] !== undefined) queue.push(record[key]);
    }
  }
  return undefined;
}

export function getImageResultIdKey(resultId: string): string {
  return `result:${resultId}`;
}

export function getImageJobIdKey(jobId: string): string {
  return `job:${jobId}`;
}

export function getImageResultKey(imageResult: ImageResult): string {
  if (imageResult.resultId) return getImageResultIdKey(imageResult.resultId);
  return `assets:${imageResult.assets.map((asset) => asset.url).join("\n")}`;
}

export function imageResultMatchesBinding(bindingKey: string | undefined, imageResult: ImageResult): boolean {
  return bindingKey === undefined || bindingKey === getImageResultKey(imageResult);
}

export function imageJobMatchesBinding(bindingKey: string | undefined, jobId: string): boolean {
  return bindingKey === undefined || bindingKey === getImageJobIdKey(jobId);
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

export function createPersistedJobState(jobId: string, imageResult?: ImageResult) {
  return {
    modelContent: imageResult
      ? `WJ image result${imageResult.resultId ? ` ${imageResult.resultId}` : ""}: ${imageResult.model}, ${imageResult.assets.length} asset(s).`
      : `WJ image job ${jobId} in progress.`,
    privateContent: {
      version: 2 as const,
      jobId,
      ...(imageResult ? { imageResult } : {}),
    } satisfies PersistedImageState,
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

export function isImageJob(value: unknown): value is ImageJob {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ImageJob>;
  return typeof record.jobId === "string"
    && record.jobId.length > 0
    && typeof record.status === "string"
    && ["queued", "running", "completed", "failed", "timed_out"].includes(record.status);
}

export function jobToImageResult(job: ImageJob): ImageResult | undefined {
  if (job.status !== "completed" || !isImageResult(job)) return undefined;
  return {
    model: job.model,
    resolution: job.resolution,
    aspectRatio: job.aspectRatio,
    durationMs: job.durationMs,
    assets: job.assets,
    resultId: job.resultId,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
  };
}
