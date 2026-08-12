import { z } from "zod";

export const profitModeSchema = z.enum(["sellingProfit", "sellingPrice"]);
export const profitCountrySchema = z.enum(["CA", "US", "MX", "ES", "UK", "FR", "MY"]);
export const profitCurrencySchema = z.enum(["USD", "CAD", "EUR", "CNY", "MXN", "MYR"]);
export const paymentProfileSchema = z.enum(["CA_LOCAL", "CA_INTL", "US", "MX", "ES", "UK", "FR", "MY"]);
export const regulatoryProfileSchema = z.enum(["NONE", "CA", "ES", "UK", "FR"]);

const profitInputShape = {
  mode: profitModeSchema.default("sellingProfit").describe(
    "sellingProfit calculates profit from a proposed selling price; sellingPrice calculates the required price for a target profit.",
  ),
  country: profitCountrySchema.describe("Shop country code."),
  cost: z.number().nonnegative().describe("Product cost in CNY."),
  shipping: z.number().nonnegative().describe("Shipping cost in CNY."),
  packaging: z.number().nonnegative().default(2).describe("Packaging cost in CNY. Defaults to 2."),
  labor: z.number().nonnegative().default(0).describe("Labor cost in CNY."),
  refund_loss_rate: z.number().min(0).max(100).default(1.5).describe("Refund and cancellation loss percentage."),
  ad_rate: z.number().min(0).max(1).default(0).describe("Offsite advertising fee as a decimal, for example 0.12 for 12%."),
  selling_price: z.number().nonnegative().optional().describe(
    "Proposed or competitor selling price. Required when mode is sellingProfit.",
  ),
  target_profit: z.number().nonnegative().optional().describe(
    "Target profit in CNY. Required when mode is sellingPrice.",
  ),
  shipping_income: z.number().nonnegative().default(0).describe("Shipping income in the selected price currency."),
  gift_wrap_income: z.number().nonnegative().default(0).describe("Gift-wrap income in the selected price currency."),
  price_currency: profitCurrencySchema.default("USD").describe("Currency used by selling price and additional income."),
  discount: z.number().min(0).max(100).default(0).describe("Discount percentage applied to the listed selling price."),
  payment_profile: paymentProfileSchema.optional().describe("Optional payment fee profile. Omit to use the shop country's default."),
  regulatory_profile: regulatoryProfileSchema.optional().describe("Optional regulatory fee profile. Omit to use the shop country's default."),
};

function validateModeInput(
  input: { mode?: "sellingProfit" | "sellingPrice"; selling_price?: number; target_profit?: number },
  ctx: z.RefinementCtx,
) {
  if ((input.mode ?? "sellingProfit") === "sellingProfit" && input.selling_price === undefined) {
    ctx.addIssue({ code: "custom", path: ["selling_price"], message: "selling_price is required in sellingProfit mode" });
  }
  if (input.mode === "sellingPrice" && input.target_profit === undefined) {
    ctx.addIssue({ code: "custom", path: ["target_profit"], message: "target_profit is required in sellingPrice mode" });
  }
}

export const calculateProfitToolInputSchema = z.object(profitInputShape).superRefine(validateModeInput);

export const saveProfitToolInputSchema = z.object({
  ...profitInputShape,
  sku: z.string().trim().min(1).max(100).describe(
    "Existing product SKU. Never invent a SKU; ask the user when it has not been provided.",
  ),
  record_name: z.string().trim().min(1).max(100).describe(
    "Short recognizable calculation name. Use the user's name when supplied; otherwise generate one from country, product context, and price.",
  ),
}).superRefine(validateModeInput);

export const profitResultItemSchema = z.object({
  label: z.string(),
  value: z.string(),
  subValue: z.string().optional(),
});

export const profitCalculationDataSchema = z.object({
  formulaVersion: z.string(),
  input: z.record(z.string(), z.unknown()),
  results: z.array(profitResultItemSchema),
  exchangeRates: z.object({
    usdRates: z.record(z.string(), z.number()),
    cnyRates: z.record(z.string(), z.number()),
    updatedAt: z.string(),
    source: z.string(),
  }),
});

export const savedProfitRecordSchema = z.object({
  id: z.string(),
  sku: z.string(),
  recordName: z.string().default(""),
  mode: profitModeSchema,
  country: z.string(),
  estimatedProfitCny: z.number(),
  roasBreakeven: z.string(),
  displaySalePriceUsd: z.number(),
  calculatedResults: z.record(z.string(), z.unknown()),
}).passthrough();

export type CalculateProfitToolInput = z.infer<typeof calculateProfitToolInputSchema>;
export type SaveProfitToolInput = z.infer<typeof saveProfitToolInputSchema>;
export type ProfitCalculationData = z.infer<typeof profitCalculationDataSchema>;
export type SavedProfitRecord = z.infer<typeof savedProfitRecordSchema>;

export function toProfitApiInput(input: CalculateProfitToolInput | SaveProfitToolInput) {
  return {
    mode: input.mode,
    country: input.country,
    cost: input.cost,
    shipping: input.shipping,
    packaging: input.packaging,
    labor: input.labor,
    refundLossRate: input.refund_loss_rate,
    adRate: input.ad_rate,
    ...(input.selling_price === undefined ? {} : { sellingPrice: input.selling_price }),
    ...(input.target_profit === undefined ? {} : { targetProfit: input.target_profit }),
    shippingIncome: input.shipping_income,
    giftWrapIncome: input.gift_wrap_income,
    priceCurrency: input.price_currency,
    discount: input.discount,
    ...(input.payment_profile ? { payment: input.payment_profile } : {}),
    ...(input.regulatory_profile ? { regulatory: input.regulatory_profile } : {}),
    ...("sku" in input ? { sku: input.sku, recordName: input.record_name } : {}),
  };
}
