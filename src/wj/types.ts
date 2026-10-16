import { z } from "zod";

import {
  ALL_ASPECT_RATIOS,
  ALL_RESOLUTIONS,
  IMAGE_MODEL_IDS,
  defaultResolutionForModel,
  imageModelOptionSummary,
  validateModelImageOptions,
} from "./image-catalog.js";

export { defaultResolutionForModel };

export const imageModelSchema = z.enum(IMAGE_MODEL_IDS);
export const aspectRatioSchema = z.enum(ALL_ASPECT_RATIOS);
export const resolutionSchema = z.enum(ALL_RESOLUTIONS);

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

/** MCP / tool JSON Schema — resolution stays optional so hosts advertise the field correctly. */
export const generateImageInputSchema = z.object({
  prompts: z
    .array(promptTextSchema)
    .min(1)
    .max(MAX_GENERATE_PROMPTS)
    .describe(
      `One or more image prompts (1–${MAX_GENERATE_PROMPTS}). Each entry generates one image; the server runs them concurrently. For a single image, pass a one-element array.`,
    ),
  model: imageModelSchema.default("gpt-image-2").describe(
    `Use gpt-image-2 unless the user explicitly requests another model. ${imageModelOptionSummary()}`,
  ),
  aspect_ratio: aspectRatioSchema.default("1:1").describe(
    "Output image aspect ratio shared by all prompts. Default remains 1:1. Use only a ratio supported by the selected model.",
  ),
  resolution: resolutionSchema
    .optional()
    .describe(
      "Optional. Default remains 1K, except nano-banana-2 which defaults to 2K. gpt-image-2.5, gpt-image-2.5-flare, and gpt-image-2.5-sunburst also default to 1K. Use only a resolution supported by the selected model.",
    ),
  gpt_reference_images: z
    .array(openAIFileSchema)
    .max(10)
    .optional()
    .describe(
      "Optional ChatGPT image attachments shared by every prompt in this call (openai/fileParams). Up to 10. Preserve attachment order; when editing, put the image being edited first, then other references. Describe changes in each prompts entry.",
    ),
}).superRefine((value, ctx) => {
  for (const issue of validateModelImageOptions(value.model, value.aspect_ratio, value.resolution)) {
    ctx.addIssue({ code: "custom", path: [issue.path], message: issue.message });
  }
});

export type GenerateImageInput = Omit<z.infer<typeof generateImageInputSchema>, "resolution"> & {
  resolution: z.infer<typeof resolutionSchema>;
};

export function parseGenerateImageInput(raw: unknown): GenerateImageInput {
  const value = generateImageInputSchema.parse(raw);
  return {
    ...value,
    resolution: value.resolution ?? defaultResolutionForModel(value.model),
  };
}

/** Persisted job input — always has resolution after parse (fills model default if missing). */
export const storedGenerateImageInputSchema = generateImageInputSchema.transform((value): GenerateImageInput => ({
  ...value,
  resolution: value.resolution ?? defaultResolutionForModel(value.model),
}));

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
  media: z
    .object({
      input_images: z.array(z.string().url()).optional(),
    })
    .optional(),
});

export const wjImageResponseSchema = z.object({
  success: z.boolean().optional(),
  status: z.string().optional(),
  code: z.number().int().optional(),
  message: z.string().optional(),
  data: wjImageDataSchema,
});

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
