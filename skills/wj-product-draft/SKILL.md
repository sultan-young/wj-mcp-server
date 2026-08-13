---
name: wj-product-draft
description: Create and update WJ product-pool drafts via MCP (SKU reservation, images, single products and product groups). Use when the user asks to create a product draft, reserve a SKU for procurement, fill product images/variant codes, or prepare ERP product entry. Does not publish; final product creation is manual in ERP/Etsy.
---

# WJ Product Draft

Use WJ product-draft tools to help users reserve SKUs and fill draft fields. Never invent category prefixes or main serial numbers. Never publish via MCP.

## Required workflow

1. Call `list_product_categories` and choose `category` by matching **label** and **describe** from the live response. Do not hardcode or recall prefixes from memory.
2. Decide **single product** vs **product group**:
   - Single: one sellable SKU, no color/size variants that need separate stock.
   - Group: same style with multiple colors/sizes/specs that need separate stock → `isGroup: true` and children with `variantSerial`.
3. Present the plan to the user: chosen category (`value` + `label`), single vs group, proposed `variantSerial` list, and that create will **immediately reserve** a SKU.
4. Wait for **explicit confirmation** ("确认创建草稿" / "可以建"). Asking how to encode is not confirmation.
5. Only then call `create_product_draft` with `user_confirmed: true`.
6. Optionally `generate_image` / `update_product_draft` to add images and fields; `validate_product_draft` to list missing ERP-required fields.
7. Tell the user the reserved SKU is ready for procurement, but the product is still a draft. **ERP create + Etsy listing remain manual.** Do not call any publish tool (none is exposed).

## Update caveats

- Changing `category` or `isGroup` re-reserves a new SKU and voids the old one — require explicit user confirmation and `user_confirmed: true`.
- When updating `children`, send the **full** list. Serials omitted from the payload are discarded (not kept).
- Child writable fields are `variantSerial`, `stock`, `images`, `cargoAttrs` only (no per-child name/notes in the pool model).

## SKU encoding rules

Core display structure:

```text
[category]-[G+groupNo | singleNo]-[variant] * [qty] ([note])
```

### Stored in product pool (`sku` / `variantSerial`)

| Type | Format | Example |
|------|--------|---------|
| Single | `{category}-{n}` | `BP-1002` |
| Group parent | `{category}-G{n}` | `BP-G1001` |
| Group child | `{groupSku}-{variantSerial}` | `BP-G1001-RED` |

- Main serials are assigned only by the server on draft create.
- `variantSerial`: uppercase `A-Z0-9`, starts with a letter, max 8 chars, unique within the group. Prefer consistent English abbreviations (e.g. `R`, `B7`, `BW`, `RDST`).
- Group parent is not the final sellable stock unit; children hold stock.

### Display / communication only (do NOT write into `Product.sku`)

- Quantity: `SKU * N` (e.g. `BP-100-A * 2`)
- Packaging / morph notes: parentheses after qty or SKU (e.g. `SK-10001-12 * 10 (bottle)`, `EB-10001(earing)`)
- Multi-SKU kits: comma-separated (e.g. `BP-1001*2, BP-G1002-B`)
- Put explanatory text in draft `notes` when persisting; keep `*N` and `(note)` out of the sku field.

## When to use a product group

Use a group when the same style has multiple attributes that must be stocked/sold separately. Use a single product when there is only one SKU. If unsure, ask before creating (create reserves a number).

## Hard prohibitions

- Do not invent category codes.
- Do not invent main serial numbers.
- Do not create a draft without explicit user confirmation.
- Do not claim the draft is published / live on Etsy.
- Do not encode quantity or packaging notes into the reserved SKU string.
