# ChatGPT private image attachments

`generate_image` accepts ChatGPT private attachments through `_meta["openai/fileParams"]` on `gpt_reference_images`. Attachments are shared by every entry in `prompts`.

## Tool contract

### `generate_image`

```json
{
  "openai/fileParams": ["gpt_reference_images"]
}
```

- `prompts` (required): string array, 1–10 entries. One image per entry; the server generates concurrently. A single image uses a one-element array.
- `gpt_reference_images` (optional): up to 10 ChatGPT attachments, shared across all `prompts` in the call.

Preserve attachment order (for example image one, image two). When editing, put the image being changed first, then other references, and describe the desired change in the relevant `prompts` entry. The server forwards download URLs to WJ `input_images` in that order for each prompt job.

## File object shape

ChatGPT supplies each authorized attachment as:

- `download_url` (required): temporary HTTPS download URL
- `file_id` (required): ChatGPT file identifier
- `mime_type` (optional)
- `file_name` (optional)

The schema declares all four properties; only `download_url` and `file_id` are required.

## Privacy and data flow

Attachments are not uploaded to a public image host by `wj-mcp-server`. Temporary ChatGPT download URLs are sent immediately to the authenticated WJ image endpoint. Do not log MCP tool arguments or WJ request bodies because temporary URLs grant short-lived access to private files.

## Deployment

Rebuild and redeploy, then refresh or reconnect the ChatGPT plugin so it rescans tool schemas:

```bash
docker compose up -d --build --force-recreate wj-mcp-server
docker compose logs -f wj-mcp-server
```

Examples:

- `Use WJ to generate a product photo inspired by the attached reference.` → `prompts: ["..."]` + `gpt_reference_images`
- `Use WJ to edit image one. Copy the name style from image two onto the board in image one.`
- `Use WJ to generate three product variants` → `prompts: ["...", "...", "..."]`
