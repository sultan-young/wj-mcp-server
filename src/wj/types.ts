import { z } from "zod";

export const imageModelSchema = z.enum(["gpt-image-2", "nano-banana-2"]);
export const aspectRatioSchema = z.enum(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "1:2", "2:1"]);
export const resolutionSchema = z.enum(["1K", "2K", "4K"]);

export const generateImageInputSchema = z.object({
  prompt: z.string().trim().min(1).max(8_000).describe("A detailed prompt describing the image to generate."),
  model: imageModelSchema.default("gpt-image-2").describe("Use gpt-image-2 unless the user explicitly requests another model."),
  aspect_ratio: aspectRatioSchema.default("1:1").describe("Output image aspect ratio."),
  resolution: resolutionSchema.default("1K").describe("Output resolution."),
  reference_image_urls: z
    .array(z.string().url().refine((value) => new URL(value).protocol === "https:", "Reference images must use HTTPS"))
    .max(4)
    .optional()
    .describe("Optional public HTTPS reference images for image-to-image generation."),
});

export const imageAssetSchema = z.object({
  type: z.string().default("image"),
  mime_type: z.string().default("image/png"),
  url: z.string().url(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  revised_prompt: z.string().optional(),
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
