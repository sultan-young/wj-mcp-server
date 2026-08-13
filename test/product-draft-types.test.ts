import { describe, expect, it } from "vitest";

import {
  createProductDraftInputSchema,
  toCreateDraftApiBody,
  toUpdateDraftApiBody,
  updateProductDraftInputSchema,
} from "../src/wj/product-draft-types.js";

describe("product draft schemas", () => {
  it("requires user_confirmed on create and strips it from the API body", () => {
    expect(() => createProductDraftInputSchema.parse({ category: "BP" })).toThrow();
    const parsed = createProductDraftInputSchema.parse({
      category: "BP",
      user_confirmed: true,
      children: [{ variantSerial: "R", stock: 1 }],
    });
    expect(toCreateDraftApiBody(parsed)).toEqual({
      category: "BP",
      children: [{ variantSerial: "R", stock: 1 }],
    });
  });

  it("requires user_confirmed when update reallocates SKU", () => {
    expect(() => updateProductDraftInputSchema.parse({
      id: "draft-1",
      category: "SK",
    })).toThrow(/user_confirmed/);

    const parsed = updateProductDraftInputSchema.parse({
      id: "draft-1",
      category: "SK",
      user_confirmed: true,
    });
    expect(toUpdateDraftApiBody(parsed)).toEqual({
      id: "draft-1",
      category: "SK",
    });
  });

  it("allows field-only updates without user_confirmed", () => {
    const parsed = updateProductDraftInputSchema.parse({
      id: "draft-1",
      nameCn: "枫叶项链",
      images: [{ url: "https://img.example.com/a.png" }],
    });
    expect(parsed.user_confirmed).toBeUndefined();
  });
});
