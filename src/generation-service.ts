import pLimit from "p-limit";

import type { AppConfig } from "./config.js";
import { ImageJobStore, type ImageJobView, type ImagePromptFailure } from "./image-job-store.js";
import { ImageResultStore } from "./image-result-store.js";
import type { AppLogger } from "./logger.js";
import { WjApiError, WjClient } from "./wj/client.js";
import {
  type GenerateImageInput,
  resolveGenerateJobs,
  type WjGenerateImageRequest,
  type WjImageData,
} from "./wj/types.js";

const POLL_INTERVAL_MS = 1_500;
const DEFAULT_POLL_WAIT_MS = 45_000;

export type GenerateBatchResult = {
  result?: WjImageData;
  failures: ImagePromptFailure[];
};

export class GenerationService {
  private readonly queues = new Map<string, ReturnType<typeof pLimit>>();
  private readonly maxConcurrency: number;
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly client: WjClient,
    private readonly jobs: ImageJobStore,
    private readonly imageResults: ImageResultStore,
    private readonly logger: AppLogger,
    config: AppConfig,
  ) {
    this.maxConcurrency = config.IMAGE_MAX_CONCURRENCY;
  }

  /** Accept a job and return immediately; WJ work continues in the background. */
  async submit(subject: string, terminalId: string, input: GenerateImageInput): Promise<ImageJobView> {
    const record = await this.jobs.create({ subject, terminalId, input });
    this.logger.info({
      jobId: record.jobId,
      terminalId,
      promptCount: input.prompts.length,
      model: input.model,
      resolution: input.resolution,
      aspectRatio: input.aspect_ratio,
      referenceCount: input.gpt_reference_images?.length ?? 0,
    }, "image job accepted");
    this.schedule(record.jobId);
    return this.jobs.toView(record);
  }

  async getJob(subject: string, jobId: string): Promise<ImageJobView | undefined> {
    const record = await this.jobs.get(subject, jobId);
    return record ? this.jobs.toView(record) : undefined;
  }

  /**
   * Return current job status. When waitMs > 0, long-poll until terminal status or wait budget.
   */
  async pollJob(subject: string, jobId: string, waitMs = DEFAULT_POLL_WAIT_MS): Promise<ImageJobView | undefined> {
    const budget = Math.max(0, Math.min(waitMs, DEFAULT_POLL_WAIT_MS));
    const deadline = Date.now() + budget;
    for (;;) {
      const view = await this.getJob(subject, jobId);
      if (!view) return undefined;
      if (isTerminalStatus(view.status) || Date.now() >= deadline) return view;
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }
  }

  /** Expand prompts and run WJ calls concurrently (partial failures allowed). */
  async generate(terminalId: string, input: GenerateImageInput): Promise<GenerateBatchResult> {
    const jobs = resolveGenerateJobs(input);
    const queue = this.getQueue(terminalId);
    try {
      if (jobs.length === 1) {
        return await this.runOne(queue, jobs[0]!, 0);
      }

      const settled = await Promise.all(
        jobs.map((job, index) => this.runOne(queue, job, index)),
      );
      return mergeBatchResults(settled);
    } finally {
      queueMicrotask(() => {
        if (queue.activeCount === 0 && queue.pendingCount === 0 && this.queues.get(terminalId) === queue) {
          this.queues.delete(terminalId);
        }
      });
    }
  }

  private async runOne(
    queue: ReturnType<typeof pLimit>,
    job: WjGenerateImageRequest,
    index: number,
  ): Promise<GenerateBatchResult> {
    try {
      const data = stampAssetDurations(await queue(() => this.client.generateImage(job)));
      this.logger.info({
        promptIndex: index,
        model: data.model_id,
        assetCount: data.assets.length,
        durationMs: data.duration_ms,
      }, "image prompt succeeded");
      return { result: data, failures: [] };
    } catch (error) {
      const message = toJobErrorMessage(error);
      this.logger.warn({
        promptIndex: index,
        err: error,
        errorMessage: message,
      }, "image prompt failed");
      return { failures: [{ index, error: message }] };
    }
  }

  private schedule(jobId: string): void {
    if (this.inFlight.has(jobId)) return;
    this.inFlight.add(jobId);
    void this.execute(jobId).finally(() => {
      this.inFlight.delete(jobId);
    });
  }

  private async execute(jobId: string): Promise<void> {
    const running = await this.jobs.markRunning(jobId);
    if (!running || running.status !== "running") return;

    this.logger.info({
      jobId,
      promptCount: running.input.prompts.length,
      model: running.model,
    }, "image job running");

    try {
      const batch = await this.generate(running.terminalId, running.input);
      const result = batch.result;
      const failures = batch.failures;
      const assets = (result?.assets ?? []).map((asset) => ({
        type: asset.type,
        mime_type: asset.mime_type,
        url: asset.url,
        ...(asset.width ? { width: asset.width } : {}),
        ...(asset.height ? { height: asset.height } : {}),
        ...(asset.revised_prompt ? { revised_prompt: asset.revised_prompt } : {}),
        ...(asset.duration_ms === undefined ? {} : { duration_ms: asset.duration_ms }),
      }));

      if (assets.length === 0) {
        const message = failures.length
          ? `All ${failures.length} image(s) failed. ${summarizeFailures(failures)}`
          : "WJ image job produced no assets.";
        this.logger.warn({ jobId, failureCount: failures.length, failures }, "image job failed with zero assets");
        await this.jobs.fail(jobId, message);
        return;
      }

      const imageResult = {
        model: result?.model_id ?? running.model,
        resolution: result?.resolution ?? running.resolution,
        aspectRatio: result?.aspect_ratio ?? running.aspectRatio,
        ...(result?.duration_ms === undefined ? {} : { durationMs: result.duration_ms }),
        assets,
      };

      let resultId: string | undefined;
      let resultCreatedAt: string | undefined;
      let resultExpiresAt: string | undefined;
      try {
        const persisted = await this.imageResults.save(running.subject, imageResult);
        resultId = persisted.resultId;
        resultCreatedAt = persisted.createdAt;
        resultExpiresAt = persisted.expiresAt;
      } catch (error) {
        this.logger.error({ err: error, jobId, tool: "persist_image_result" }, "Failed to persist generated image result");
      }

      const partialError = failures.length
        ? `${failures.length} of ${running.input.prompts.length} image(s) failed. ${summarizeFailures(failures)}`
        : undefined;

      await this.jobs.complete(jobId, {
        assets,
        failures,
        model: imageResult.model,
        resolution: imageResult.resolution,
        aspectRatio: imageResult.aspectRatio,
        durationMs: imageResult.durationMs,
        resultId,
        resultCreatedAt,
        resultExpiresAt,
        ...(partialError ? { error: partialError } : {}),
      });
      this.logger.info({
        jobId,
        resultId,
        successCount: assets.length,
        failureCount: failures.length,
        failures,
      }, "image job completed");
    } catch (error) {
      const message = toJobErrorMessage(error);
      this.logger.warn({ err: error, jobId }, "Background WJ image job failed");
      await this.jobs.fail(jobId, message);
    }
  }

  private getQueue(terminalId: string): ReturnType<typeof pLimit> {
    const existing = this.queues.get(terminalId);
    if (existing) return existing;

    const queue = pLimit(this.maxConcurrency);
    this.queues.set(terminalId, queue);
    return queue;
  }
}

function mergeBatchResults(batches: GenerateBatchResult[]): GenerateBatchResult {
  const successes = batches
    .map((batch) => batch.result)
    .filter((value): value is WjImageData => value !== undefined);
  const failures = batches.flatMap((batch) => batch.failures);
  if (!successes.length) return { failures };
  return {
    result: mergeGeneratedImages(successes),
    failures,
  };
}

function mergeGeneratedImages(results: WjImageData[]): WjImageData {
  const stamped = results.map(stampAssetDurations);
  return {
    model_id: stamped[0]?.model_id ?? "unknown",
    resolution: stamped[0]?.resolution,
    aspect_ratio: stamped[0]?.aspect_ratio,
    assets: stamped.flatMap((result) => result.assets),
  };
}

/** Copy top-level WJ duration onto each asset so the widget can show the selected image's time. */
function stampAssetDurations(result: WjImageData): WjImageData {
  if (result.duration_ms === undefined) return result;
  return {
    ...result,
    assets: result.assets.map((asset) => ({
      ...asset,
      duration_ms: asset.duration_ms ?? result.duration_ms,
    })),
  };
}

function isTerminalStatus(status: ImageJobView["status"]): boolean {
  return status === "completed" || status === "failed" || status === "timed_out";
}

function toJobErrorMessage(error: unknown): string {
  if (error instanceof WjApiError) {
    if (error.status === 401 || error.status === 403) return `WJ request was rejected with HTTP ${error.status}: ${error.message}`;
    if (error.status === 429) return "WJ is currently rate-limited. Please try again later.";
    return error.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return "WJ image job failed unexpectedly.";
}

function summarizeFailures(failures: ImagePromptFailure[]): string {
  return failures
    .slice(0, 5)
    .map((failure) => `#${failure.index + 1}: ${failure.error}`)
    .join(" | ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
