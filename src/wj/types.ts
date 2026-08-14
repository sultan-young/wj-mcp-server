import { z } from "zod";

export const imageModelSchema = z.enum(["gpt-image-2", "nano-banana-2"]);
export const aspectRatioSchema = z.enum(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "1:2", "2:1"]);
export const resolutionSchema = z.enum(["1K", "2K", "4K"]);

export const MAX_GENERATE_PROMPTS = 10;

export const openAIFileSchema = z
  .object({
    download_url: z
      .string()
      .url()
      .refine((value) => new URL(value).protocol === "https:", "ChatGPT files must use HTTPS"),
    file_id: z.string().min(1),
    mime_type: z.string().optional(),
    file_name: z.string().optional(),
  })
  .strict();

const promptTextSchema = z.string().trim().min(1).max(8_000);

export const generateImageInputSchema = z.object({
  prompts: z
    .array(promptTextSchema)
    .min(1)
    .max(MAX_GENERATE_PROMPTS)
    .describe(
      `One or more image prompts (1–${MAX_GENERATE_PROMPTS}). Each entry generates one image; the server runs them concurrently. For a single image, pass a one-element array.`,
    ),
  model: imageModelSchema.default("gpt-image-2").describe("Use gpt-image-2 unless the user explicitly requests another model."),
  aspect_ratio: aspectRatioSchema.default("1:1").describe("Output image aspect ratio (shared by all prompts)."),
  resolution: resolutionSchema.default("2K").describe("Default to 2K unless the user explicitly requests 1K or 4K."),
  gpt_reference_images: z
    .array(openAIFileSchema)
    .max(10)
    .optional()
    .describe(
      "Optional ChatGPT image attachments shared by every prompt in this call (openai/fileParams). Up to 10. Preserve attachment order; when editing, put the image being edited first, then other references. Describe changes in each prompts entry.",
    ),
});

export const imageAssetSchema = z.object({
  type: z.string().default("image"),
  mime_type: z.string().default("image/png"),
  url: z.string().url(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  revised_prompt: z.string().optional(),
  duration_ms: z.number().int().nonnegative().optional(),
  /** Prompt index within a multi-prompt job (for ordered progressive display). */
  prompt_index: z.number().int().nonnegative().optional(),
});

export const wjImageDataSchema = z.object({
  model_id: z.string(),
  resolution: z.string().optional(),
  aspect_ratio: z.string().optional(),
  duration_ms: z.number().int().nonnegative().optional(),
  assets: z.array(imageAssetSchema).min(1),
});

export const wjImageResponseSchema = z.object({
  success: z.boolean().optional(),
  status: z.string().optional(),
  code: z.number().int().optional(),
  message: z.string().optional(),
  data: wjImageDataSchema,
});

export type GenerateImageInput = z.infer<typeof generateImageInputSchema>;
export type ImageAsset = z.infer<typeof imageAssetSchema>;
export type WjImageData = z.infer<typeof wjImageDataSchema>;

/** One WJ request after expanding prompts. */
export type WjGenerateImageRequest = {
  prompt: string;
  model: GenerateImageInput["model"];
  aspect_ratio: GenerateImageInput["aspect_ratio"];
  resolution: GenerateImageInput["resolution"];
  gpt_reference_images?: GenerateImageInput["gpt_reference_images"];
};

export function resolveGenerateJobs(input: GenerateImageInput): WjGenerateImageRequest[] {
  const sharedRefs = input.gpt_reference_images?.length
    ? { gpt_reference_images: input.gpt_reference_images }
    : {};
  return input.prompts.map((prompt) => ({
    prompt,
    model: input.model,
    aspect_ratio: input.aspect_ratio,
    resolution: input.resolution,
    ...sharedRefs,
  }));
}

/** Map ChatGPT file attachments to WJ input_images URLs (order preserved). */
export function resolveGenerateReferenceUrls(input: WjGenerateImageRequest): string[] | undefined {
  const urls = (input.gpt_reference_images ?? []).map((file) => file.download_url);
  return urls.length ? urls : undefined;
}
