import type { AppConfig } from "../config.js";
import type { AppLogger } from "../logger.js";
import { APP_VERSION } from "../version.js";
import { type GenerateImageInput, type WjImageData, wjImageResponseSchema } from "./types.js";

export class WjApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "WjApiError";
  }
}

export class WjClient {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: AppLogger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async generateImage(input: GenerateImageInput): Promise<WjImageData> {
    if (!this.config.WJ_ALLOWED_MODELS.includes(input.model)) {
      throw new WjApiError(`Model ${input.model} is not allowed`);
    }

    const endpoint = new URL(this.config.WJ_IMAGE_PATH, this.config.wjApiBaseUrl);
    const requestBody = {
      model: input.model,
      prompt: input.prompt,
      ...(input.reference_image_urls?.length ? { input_images: input.reference_image_urls } : {}),
      output: {
        aspect_ratio: input.aspect_ratio,
        resolution: input.resolution,
      },
      response_format: "url",
    };

    const startedAt = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.WJ_API_KEY}`,
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": `wj-mcp-server/${APP_VERSION}`,
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(this.config.WJ_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const isTimeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new WjApiError(isTimeout ? "WJ image generation timed out" : "Unable to reach the WJ image service");
    }

    const rawBody = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw new WjApiError("WJ returned a non-JSON response", response.status);
    }

    if (!response.ok) {
      const upstreamMessage = extractUpstreamMessage(json);
      this.logger.warn({ status: response.status, durationMs: Date.now() - startedAt }, "WJ image request failed");
      throw new WjApiError(upstreamMessage ?? `WJ request failed with HTTP ${response.status}`, response.status);
    }

    const parsed = wjImageResponseSchema.safeParse(json);
    if (!parsed.success || parsed.data.success === false) {
      this.logger.warn({ status: response.status, durationMs: Date.now() - startedAt }, "Invalid WJ image response");
      throw new WjApiError(parsed.success ? parsed.data.message ?? "WJ reported generation failure" : "WJ returned an invalid image response", response.status);
    }

    for (const asset of parsed.data.data.assets) {
      if (this.config.NODE_ENV === "production" && new URL(asset.url).protocol !== "https:") {
        throw new WjApiError("WJ returned an insecure image URL", response.status);
      }
    }

    this.logger.info(
      {
        model: parsed.data.data.model_id,
        assetCount: parsed.data.data.assets.length,
        durationMs: Date.now() - startedAt,
      },
      "WJ image generated",
    );
    return parsed.data.data;
  }
}

function extractUpstreamMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  for (const key of ["message", "error_description", "error"]) {
    const value = record[key];
    if (typeof value === "string" && value.length <= 500) return value;
  }
  return undefined;
}
