import { z } from "zod";

const draftImageSchema = z.object({
  url: z.string().url().describe("HTTPS image URL (for example from generate_image)."),
  name: z.string().optional(),
  picturebedId: z.string().optional(),
  uid: z.string().optional(),
  size: z.number().optional(),
}).passthrough();

const draftChildSchema = z.object({
  variantSerial: z
    .string()
    .trim()
    .min(1)
    .max(8)
    .regex(/^[A-Z][A-Z0-9]*$/, "variantSerial must start with A-Z and contain only A-Z0-9, max 8 chars")
    .describe("Child variant suffix only (not the full SKU). Example: RDST, R, B7."),
  stock: z.number().int().nonnegative().optional().describe("Child stock quantity. Group parent has no stock."),
  images: z.array(draftImageSchema).optional(),
  cargoAttrs: z.array(z.string()).optional(),
}).passthrough();

const optionalDraftFields = {
  isGroup: z.boolean().optional().describe("true = product group (SKU gets -G{n}); false/omit = single product."),
  nameCn: z.string().optional(),
  nameEn: z.string().optional(),
  images: z.array(draftImageSchema).optional(),
  notes: z.string().optional().describe("Internal product notes. Do not put packaging notes into the SKU string."),
  tags: z.array(z.string()).optional(),
  costPriceRMB: z.number().nonnegative().optional(),
  salePriceUSD: z.number().nonnegative().optional(),
  saleShipPriceUSD: z.number().nonnegative().optional(),
  shippingFeeRMB: z.number().nonnegative().optional(),
  stock: z.number().int().nonnegative().optional().describe("Stock for single products only. Groups use children[].stock."),
  cargoAttrs: z.array(z.string()).optional(),
  listingLink: z.string().url().optional(),
  children: z.array(draftChildSchema).optional().describe(
    "For groups: each child needs variantSerial. On update, omitted serials are discarded — send the full children list.",
  ),
  suppliers: z.array(z.string()).optional().describe("Supplier ObjectId strings from ERP when known."),
  relatedStores: z.array(z.string()).optional().describe("Store ObjectId strings from ERP when known."),
};

export const listProductCategoriesInputSchema = z.object({}).strict();

export const productCategorySchema = z.object({
  value: z.string(),
  label: z.string(),
  describe: z.string().optional().default(""),
  id: z.string().optional(),
}).passthrough();

export const createProductDraftInputSchema = z.object({
  category: z.string().trim().min(1).max(32).describe(
    "Category code from list_product_categories.value. Never invent a prefix.",
  ),
  ...optionalDraftFields,
  user_confirmed: z.literal(true).describe(
    "Must be true only after the user explicitly confirmed creating the draft (SKU reservation is irreversible).",
  ),
});

export const updateProductDraftInputSchema = z.object({
  id: z.string().trim().min(1).describe("Draft product id returned by create/get/list."),
  category: z.string().trim().min(1).max(32).optional().describe(
    "Changing category re-reserves a new SKU and voids the old one.",
  ),
  ...optionalDraftFields,
  user_confirmed: z.literal(true).optional().describe(
    "Required true when changing category or isGroup (SKU reallocation).",
  ),
}).superRefine((value, ctx) => {
  const reallocates = value.category !== undefined || value.isGroup !== undefined;
  if (reallocates && value.user_confirmed !== true) {
    ctx.addIssue({
      code: "custom",
      path: ["user_confirmed"],
      message: "user_confirmed must be true when changing category or isGroup (SKU reallocation)",
    });
  }
});

export const getProductDraftInputSchema = z.object({
  id: z.string().trim().min(1).describe("Draft id."),
});

export const listProductDraftsInputSchema = z.object({
  page_no: z.number().int().positive().default(1),
  page_size: z.number().int().positive().max(100).default(20),
  category: z.string().trim().optional(),
  sku: z.string().trim().optional().describe("Filter by reserved SKU substring."),
  keyword: z.string().trim().optional(),
});

export const validateProductDraftInputSchema = z.object({
  id: z.string().trim().min(1),
});

export const productDraftSchema = z.object({
  id: z.string().optional(),
  sku: z.string().optional(),
  reservedSku: z.string().optional(),
  category: z.string().optional(),
  isGroup: z.boolean().optional(),
  publishStatus: z.string().optional(),
  isDraft: z.boolean().optional(),
  nameCn: z.string().optional(),
  nameEn: z.string().optional(),
  reservedChildSkus: z.array(z.string()).optional(),
  children: z.array(z.unknown()).optional(),
  images: z.array(z.unknown()).optional(),
  notes: z.string().optional(),
  skuReallocated: z.boolean().optional(),
  previousReservedSku: z.string().optional(),
  warning: z.string().optional(),
}).passthrough();

export const draftValidationSchema = z.object({
  ok: z.boolean(),
  missing: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  errors: z.array(z.string()).default([]),
}).passthrough();

export const validateProductDraftResultSchema = z.object({
  draft: productDraftSchema,
  validation: draftValidationSchema,
}).passthrough();

export const listProductDraftsResultSchema = z.object({
  list: z.array(productDraftSchema),
  pagination: z.object({
    pageNo: z.number().optional(),
    pageSize: z.number().optional(),
    total: z.number().optional(),
  }).passthrough().optional(),
});

export type CreateProductDraftInput = z.infer<typeof createProductDraftInputSchema>;
export type UpdateProductDraftInput = z.infer<typeof updateProductDraftInputSchema>;
export type GetProductDraftInput = z.infer<typeof getProductDraftInputSchema>;
export type ListProductDraftsInput = z.infer<typeof listProductDraftsInputSchema>;
export type ValidateProductDraftInput = z.infer<typeof validateProductDraftInputSchema>;
export type ProductDraft = z.infer<typeof productDraftSchema>;
export type ProductCategory = z.infer<typeof productCategorySchema>;

export function toCreateDraftApiBody(input: CreateProductDraftInput) {
  const { user_confirmed: _confirmed, ...rest } = input;
  return rest;
}

export function toUpdateDraftApiBody(input: UpdateProductDraftInput) {
  const { user_confirmed: _confirmed, ...rest } = input;
  return rest;
}

export function toListDraftsApiBody(input: ListProductDraftsInput) {
  return {
    pagination: { pageNo: input.page_no, pageSize: input.page_size },
    queryParams: {
      ...(input.category ? { category: input.category } : {}),
      ...(input.sku ? { sku: input.sku } : {}),
      ...(input.keyword ? { keyword: input.keyword } : {}),
    },
  };
}
