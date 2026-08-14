import {
  getImageJob,
  getImageJobId,
  getImageResult,
  jobToImageResult,
  type ImageJob,
  type ImageResult,
} from "./image-result-state.js";

/** Widget lifecycle after generate_image. */
export type WidgetPhase = "in_progress" | "completed" | "lost";

export type RestorePlan =
  | { kind: "render"; imageResult: ImageResult }
  | { kind: "probe_status"; jobId: string }
  | { kind: "lost"; reason: string }
  | { kind: "none" };

type PersistedV3 = {
  version: 3;
  phase: WidgetPhase;
  jobId?: string;
  imageResult?: ImageResult;
};

/**
 * Decide how to hydrate the widget after remount / refresh.
 * Prefer a completed asset snapshot; otherwise look up by jobId.
 */
export function resolveRestorePlan(source: unknown): RestorePlan {
  const imageResult = getImageResult(source);
  if (imageResult) return { kind: "render", imageResult };

  const phase = readPersistedPhase(source);
  const jobId = getImageJobId(source);
  const job = getImageJob(source);

  if (phase === "lost") {
    return { kind: "lost", reason: "图片结果暂时无法恢复，请使用消息中的原图链接。" };
  }

  if (job) {
    if (job.status === "completed") {
      const completed = jobToImageResult(job);
      if (completed) return { kind: "render", imageResult: completed };
      return { kind: "lost", reason: "任务已完成但没有可展示的图片。" };
    }
    if (job.status === "failed" || job.status === "timed_out") {
      const partial = jobToImageResult(job);
      if (partial) return { kind: "render", imageResult: partial };
      return { kind: "lost", reason: job.error ?? `任务 ${job.status}` };
    }
    return { kind: "probe_status", jobId: job.jobId };
  }

  if (jobId) return { kind: "probe_status", jobId };

  if (phase === "completed") {
    return { kind: "lost", reason: "已完成的图片结果无法恢复，请使用消息中的原图链接。" };
  }

  return { kind: "none" };
}

export function createPersistedInProgressState(jobId: string) {
  return {
    modelContent: `WJ image job ${jobId} in progress.`,
    privateContent: {
      version: 3 as const,
      phase: "in_progress" as const,
      jobId,
    } satisfies PersistedV3,
  };
}

export function createPersistedCompletedState(imageResult: ImageResult, jobId: string) {
  return {
    modelContent: `WJ image job ${jobId}: ${imageResult.model}, ${imageResult.assets.length} asset(s).`,
    privateContent: {
      version: 3 as const,
      phase: "completed" as const,
      jobId,
      imageResult: { ...imageResult, jobId: imageResult.jobId ?? jobId },
    } satisfies PersistedV3,
  };
}

export function createPersistedLostState(reason: string, jobId?: string) {
  return {
    modelContent: `WJ image unavailable: ${reason}`,
    privateContent: {
      version: 3 as const,
      phase: "lost" as const,
      ...(jobId ? { jobId } : {}),
    } satisfies PersistedV3,
  };
}

/** Map a status-tool job snapshot into the next UI action. */
export function planAfterStatus(job: ImageJob): RestorePlan {
  if (job.status === "failed" || job.status === "timed_out") {
    if (job.assets.length > 0) {
      const imageResult = jobToImageResult(job);
      if (imageResult) return { kind: "render", imageResult };
    }
    return { kind: "lost", reason: job.error ?? `任务 ${job.status}` };
  }
  if (job.status === "completed") {
    const imageResult = jobToImageResult(job);
    if (imageResult) return { kind: "render", imageResult };
    return { kind: "lost", reason: "任务已完成但没有可展示的图片。" };
  }
  return { kind: "probe_status", jobId: job.jobId };
}

function readPersistedPhase(source: unknown): WidgetPhase | undefined {
  const queue: unknown[] = [source];
  const visited = new Set<object>();
  while (queue.length > 0 && visited.size < 16) {
    const candidate = queue.shift();
    if (!candidate || typeof candidate !== "object" || visited.has(candidate)) continue;
    visited.add(candidate);
    const record = candidate as Record<string, unknown>;
    if (record.phase === "in_progress" || record.phase === "completed" || record.phase === "lost") {
      return record.phase;
    }
    for (const key of ["privateContent", "structuredContent", "widgetState"]) {
      if (record[key] !== undefined) queue.push(record[key]);
    }
  }
  return undefined;
}
