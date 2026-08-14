import pLimit from "p-limit";

import type { AppConfig } from "./config.js";
import { ImageJobStore, type ImageJobView, type ImagePromptFailure } from "./image-job-store.js";
import type { AppLogger } from "./logger.js";
import { WjApiError, WjClient, appendWjCallData } from "./wj/client.js";
import {
  type GenerateImageInput,
  resolveGenerateJobs,
  type WjGenerateImageRequest,
  type WjImageData,
} from "./wj/types.js";

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

  /** Lookup by jobId: current progressive status or durable completed snapshot. */
  async getImage(subject: string, jobId: string): Promise<ImageJobView | undefined> {
    return this.getJob(subject, jobId);
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
      const data = stampAssetDurations(await queue(() => this.client.generateImage(job)), index);
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
      const promptJobs = resolveGenerateJobs(running.input);
      const queue = this.getQueue(running.terminalId);
      const settled = await Promise.all(
        promptJobs.map(async (promptJob, index) => {
          const outcome = await this.runOne(queue, promptJob, index);
          if (outcome.result?.assets[0]) {
            await this.jobs.appendPromptOutcome(jobId, {
              index,
              asset: outcome.result.assets[0],
              model: outcome.result.model_id,
              resolution: outcome.result.resolution ?? running.resolution,
              aspectRatio: outcome.result.aspect_ratio ?? running.aspectRatio,
            });
          }
          if (outcome.failures[0]) {
            await this.jobs.appendPromptOutcome(jobId, {
              index,
              failure: outcome.failures[0],
            });
          }
          return outcome;
        }),
      );

      const batch = mergeBatchResults(settled);
      const result = batch.result;
      const failures = batch.failures;
      const assets = (result?.assets ?? []).map((asset, index) => ({
        type: asset.type,
        mime_type: asset.mime_type,
        url: asset.url,
        ...(asset.width ? { width: asset.width } : {}),
        ...(asset.height ? { height: asset.height } : {}),
        ...(asset.revised_prompt ? { revised_prompt: asset.revised_prompt } : {}),
        ...(asset.duration_ms === undefined ? {} : { duration_ms: asset.duration_ms }),
        prompt_index: asset.prompt_index ?? index,
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
        ...(partialError ? { error: partialError } : {}),
      });
      this.logger.info({
        jobId,
        successCount: assets.length,
        failureCount: failures.length,
        failures,
      }, "image job completed");
    } catch (error) {
      const message = toJobErrorMessage(error);
      this.logger.warn({ err: error, jobId }, "Background WJ image job failed");
      await this.jobs.fail(jobId, message);
    } finally {
      const queue = this.queues.get(running.terminalId);
      if (queue) {
        queueMicrotask(() => {
          if (queue.activeCount === 0 && queue.pendingCount === 0 && this.queues.get(running.terminalId) === queue) {
            this.queues.delete(running.terminalId);
          }
        });
      }
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
  return {
    model_id: results[0]?.model_id ?? "unknown",
    resolution: results[0]?.resolution,
    aspect_ratio: results[0]?.aspect_ratio,
    assets: results.flatMap((result) => result.assets),
  };
}

/** Copy top-level WJ duration onto each asset; stamp prompt_index for ordering. */
function stampAssetDurations(result: WjImageData, promptIndex?: number): WjImageData {
  return {
    ...result,
    assets: result.assets.map((asset) => ({
      ...asset,
      duration_ms: asset.duration_ms ?? result.duration_ms,
      ...(promptIndex === undefined ? {} : { prompt_index: asset.prompt_index ?? promptIndex }),
    })),
  };
}

function toJobErrorMessage(error: unknown): string {
  if (error instanceof WjApiError) {
    if (error.status === 401 || error.status === 403) {
      return appendWjCallData(
        `WJ request was rejected with HTTP ${error.status}: ${error.message}`,
        error.callData,
      );
    }
    if (error.status === 429) {
      return appendWjCallData("WJ is currently rate-limited. Please try again later.", error.callData);
    }
    return appendWjCallData(error.message, error.callData);
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
