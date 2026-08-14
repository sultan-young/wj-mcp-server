---
name: wj-image-generation
description: Generate, edit, and display images with the WJ MCP tools. Use when the user explicitly requests WJ or 无界 image generation or editing, or when a native ChatGPT image-generation attempt in the current conversation visibly fails because its quota is exhausted, it is rate-limited, or it is temporarily unavailable.
---

# WJ Image Generation

Use `generate_image` for creation and editing. It returns a `jobId` immediately. After you receive the `jobId`, reply to the user right away—the WJ image component shows results on its own. Use `get_image_job_result` with that same `jobId` only when the component failed or is missing.

## Route the request

1. Call `generate_image` immediately when the user explicitly asks for WJ, WJ image generation/editing, or 无界生图.
2. If a native ChatGPT image-generation attempt in the current conversation explicitly reports quota exhaustion, rate limiting, or temporary unavailability, call `generate_image` once without asking the user again.
3. Do not claim to detect or know the user's native ChatGPT image quota. Only apply automatic fallback when the failure is visible in the conversation.
4. Do not force WJ for a generic image request when the user did not request WJ and no native failure is visible.
5. Respect an explicit request not to use WJ.

## Plan before complex multi-image work

1. When the user provides several product photos and asks for a wash/retouch plan (for example Etsy listing sets), first outline which outputs to create and which source images each output should use.
2. After the plan is clear (or the user confirms it), execute with `generate_image` according to the dispatch rules below.
3. Do not invent extra outputs the user did not ask for.

## Dispatch: one call vs concurrent calls

`gpt_reference_images` is shared by every entry in that same `generate_image` call. Choose the dispatch pattern from the plan:

1. **Same reference set for every output** — one `generate_image` call. Put each output text in `prompts` (1–10). The server generates those entries concurrently in the background.
2. **Different reference subsets per output** (for example output A uses images 1–3, output B uses 4–5, size chart uses image 10) — issue **one `generate_image` call per output group**, each with its own `prompts` and `gpt_reference_images`.
3. For case 2, dispatch **all of those independent `generate_image` calls in the same tool-call turn concurrently**. Do not wait for one call to finish before starting the next.
4. Never serialize independent wash/generate jobs when they do not depend on each other's results.

## Build the WJ request

1. Preserve the user's subject, style, composition, aspect ratio, resolution, and reference-image intent.
2. Always pass `prompts` as a string array (1–10). A single image uses a one-element array.
3. Default to `gpt-image-2`, `1K`, and `1:1` only when the user does not specify supported alternatives. When using `nano-banana-2`, default resolution to `2K` unless the user specifies otherwise.
4. Use `nano-banana-2` only when the user explicitly requests it.
5. For same-prompt variants within one shared-reference call, repeat that text in `prompts`. For different texts with the same references, put each distinct text in `prompts`.
6. Pass ChatGPT attachments through `gpt_reference_images` (official file params, up to 10). Within one call they are shared by every `prompts` entry.
7. Preserve attachment order for labels such as image one and image two. When editing, put the image being changed first in `gpt_reference_images`, then other references, and describe the change in the relevant `prompts` entry.

## Handle results

1. `generate_image` returns a `jobId` immediately (status `queued`/`running`). Treat this as job accepted, not as finished images.
2. As soon as you have the `jobId`, reply to the user that WJ has accepted the job and the image component is generating. Do **not** wait for completion yourself, and do **not** call `get_image_job_result` while the component is healthy.
3. Prefer the WJ image component for display. Never paste markdown image embeds (`![](url)`).
4. Do not claim images are ready until the component shows assets. You may say generation is in progress / accepted.
5. Identify the result as generated through WJ.
6. If the component fails with "Failed to fetch template" or is missing and a `jobId` is available, call `get_image_job_result(job_id)`, then paste plain-text HTTPS links if needed. Never regenerate solely because the component failed to display.
7. `get_image_job_result` requires `job_id`. Read-only; no WJ image quota. Model use is for recovery only.
8. If recovery is unavailable: paste plain-text HTTPS original links from the tool result (URLs only, no markdown image syntax). Do not regenerate automatically.
9. Retry the same request at most once for a transient timeout or `502`-class upstream failure on job submission.
10. Do not retry authentication, authorization, WJ quota, or WJ rate-limit failures reported on a failed job. Report the actionable error clearly, including LiteLLM `call_id`, `model_id`, and `model_api_base` when the failed job includes them.
