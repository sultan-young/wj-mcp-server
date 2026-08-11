import { z } from "zod";

export const imageModelSchema = z.enum(["gpt-image-2", "nano-banana-2"]);
export const aspectRatioSchema = z.enum(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "1:2", "2:1"]);
export const resolutionSchema = z.enum(["1K", "2K", "4K"]);

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

export const generateImageInputSchema = z.object({
  prompt: z.string().trim().min(1).max(8_000).describe("A detailed prompt describing the image to generate."),
  model: imageModelSchema.default("gpt-image-2").describe("Use gpt-image-2 unless the user explicitly requests another model."),
  aspect_ratio: aspectRatioSchema.default("1:1").describe("Output image aspect ratio."),
  resolution: resolutionSchema.default("2K").describe("Default to 2K unless the user explicitly requests 1K or 4K."),
  reference_image_urls: z
    .array(z.string().url().refine((value) => new URL(value).protocol === "https:", "Reference images must use HTTPS"))
    .max(4)
    .optional()
    .describe("Optional public HTTPS reference images for image-to-image generation."),
});

export const editImageInputSchema = z.object({
  prompt: z.string().trim().min(1).max(8_000).describe("Detailed instructions for editing the target image."),
  target_image: openAIFileSchema.describe("The primary ChatGPT image attachment to edit."),
  reference_images: z
    .array(openAIFileSchema)
    .max(3)
    .optional()
    .describe("Optional ChatGPT image attachments used as style, text, layout, or identity references."),
  model: imageModelSchema.default("gpt-image-2").describe("Use gpt-image-2 unless the user explicitly requests another model."),
  aspect_ratio: aspectRatioSchema.default("1:1").describe("Output image aspect ratio."),
  resolution: resolutionSchema.default("2K").describe("Default to 2K unless the user explicitly requests 1K or 4K."),
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
export type EditImageInput = z.infer<typeof editImageInputSchema>;
export type ImageAsset = z.infer<typeof imageAssetSchema>;
export type WjImageData = z.infer<typeof wjImageDataSchema>;
