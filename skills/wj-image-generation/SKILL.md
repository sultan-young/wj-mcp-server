---
name: wj-image-generation
description: Generate, edit, and display images with the WJ MCP tools. Use when the user explicitly requests WJ or 无界 image generation or editing, or when a native ChatGPT image-generation attempt in the current conversation visibly fails because its quota is exhausted, it is rate-limited, or it is temporarily unavailable.
---

# WJ Image Generation

Use the WJ plugin's `generate_image` and `edit_image` tools for image creation, and `get_image_result` only to recover an existing completed result.

## Route the request

1. Call `generate_image` immediately when the user explicitly asks for WJ, WJ image generation, or 无界生图.
2. Call `edit_image` immediately when the user explicitly asks WJ to edit one or more ChatGPT image attachments.
3. If a native ChatGPT image-generation attempt in the current conversation explicitly reports quota exhaustion, rate limiting, or temporary unavailability, call `generate_image` once without asking the user again.
4. Do not claim to detect or know the user's native ChatGPT image quota. Only apply automatic fallback when the failure is visible in the conversation.
5. Do not force WJ for a generic image request when the user did not request WJ and no native failure is visible.
6. Respect an explicit request not to use WJ.

## Build the WJ request

1. Preserve the user's prompt, subject, style, composition, aspect ratio, resolution, and reference-image intent.
2. Default to `gpt-image-2`, `2K`, and `1:1` only when the user does not specify supported alternatives.
3. Use `nano-banana-2` only when the user explicitly requests it.
4. Pass reference image URLs through `reference_image_urls` when provided.
5. For ChatGPT attachments, put the image being changed in `target_image` and style, text, layout, or identity references in `reference_images`.
6. Preserve attachment order for labels such as image one and image two. Do not ask for public URLs when ChatGPT file parameters are available.
7. Each `generate_image` call creates exactly one image. For multiple requested images, make one independent `generate_image` call per image.
8. Dispatch all independent `generate_image` calls concurrently in the same tool-call turn. Never wait for one image to finish before starting the next.
9. For same-prompt variants, reuse the exact prompt in every concurrent call. For different images, preserve each requested prompt in its own concurrent call.
10. Apply the same concurrent-call rule to multiple independent `edit_image` outputs.

## Handle results

1. Treat generation as successful only when the tool returns at least one asset.
2. Let the associated WJ MCP image component display successful results; do not replace it with a fabricated attachment.
3. Identify the result as generated through WJ.
4. If an image component does not display and a `resultId` is available, call `get_image_result` before doing anything else. Never regenerate solely because the component failed to display.
5. `get_image_result` is a read-only recovery tool: it retrieves the completed result, mounts the image component again, and consumes no WJ image quota.
6. If recovery is unavailable or the result has expired, use the fallback original-image links and explain the limitation without regenerating automatically.
7. Retry the same request at most once for a transient timeout or `502`-class upstream failure.
8. Do not retry authentication, authorization, WJ quota, or WJ rate-limit failures. Report the actionable error clearly.
