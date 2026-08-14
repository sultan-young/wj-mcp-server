export type ImageAsset = {
  url: string;
  mime_type?: string;
  width?: number;
  height?: number;
  duration_ms?: number;
  prompt_index?: number;
};

export type ImageResult = {
  jobId?: string;
  model: string;
  resolution?: string;
  aspectRatio?: string;
  durationMs?: number;
  assets: ImageAsset[];
  failureCount?: number;
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
  failures?: Array<{ index: number; error: string }>;
  progress?: {
    total: number;
    succeeded: number;
    failed: number;
    pending: number;
  };
  error?: string;
  createdAt?: string;
  updatedAt?: string;
  expiresAt?: string;
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
    for (const key of ["structuredContent", "privateContent", "_meta", "toolOutput", "toolResponseMetadata", "imageResult"]) {
      if (record[key] !== undefined) queue.push(record[key]);
    }
  }
  return undefined;
}

export function getImageJobIdKey(jobId: string): string {
  return `job:${jobId}`;
}

export function getImageResultKey(imageResult: ImageResult): string {
  const assetKey = imageResult.assets.map((asset) => asset.url).join("\n");
  if (imageResult.jobId) return `${getImageJobIdKey(imageResult.jobId)}|${assetKey}`;
  return `assets:${assetKey}`;
}

export function imageResultMatchesBinding(bindingKey: string | undefined, imageResult: ImageResult): boolean {
  if (bindingKey === undefined) return true;
  if (imageResult.jobId && bindingKey === getImageJobIdKey(imageResult.jobId)) return true;
  return bindingKey === getImageResultKey(imageResult);
}

export function imageJobMatchesBinding(bindingKey: string | undefined, jobId: string): boolean {
  return bindingKey === undefined || bindingKey === getImageJobIdKey(jobId);
}

/** True when get_image_job_result returned a terminal host/tool error (do not keep polling). */
export function isTerminalImageJobToolFailure(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.isError !== true) return undefined;
  const text = collectToolText(record);
  if (/not found|has expired|belongs to another user/i.test(text)) {
    return "生图任务已过期或不存在，无法继续轮询。";
  }
  return text || "查询生图任务失败。";
}

function collectToolText(record: Record<string, unknown>): string {
  const parts: string[] = [];
  const content = record.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
        parts.push((item as { text: string }).text);
      }
    }
  }
  if (typeof record.message === "string") parts.push(record.message);
  return parts.join(" ").trim();
}

export function isImageResult(value: unknown): value is ImageResult {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ImageResult> & { status?: unknown };
  // Job snapshots also have model+assets; require no job status field.
  if (typeof record.status === "string") return false;
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
  if (!Array.isArray(job.assets) || job.assets.length === 0) return undefined;
  if (!job.assets.every((asset) => asset && typeof asset.url === "string" && asset.url.startsWith("https://"))) {
    return undefined;
  }
  return {
    jobId: job.jobId,
    model: job.model,
    resolution: job.resolution,
    aspectRatio: job.aspectRatio,
    durationMs: job.durationMs,
    assets: job.assets,
    failureCount: job.failures?.length ?? 0,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
  };
}

export function isTerminalImageJobStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "timed_out";
}
