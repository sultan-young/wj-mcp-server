# ChatGPT private image attachments

`edit_image` accepts ChatGPT private attachments through the official MCP tool file-parameter extension.

## Tool contract

The tool descriptor declares:

```json
{
  "openai/fileParams": ["target_image", "reference_images"]
}
```

ChatGPT supplies each authorized attachment as an object containing:

- `download_url` (required): a temporary HTTPS download URL
- `file_id` (required): the ChatGPT file identifier
- `mime_type` (optional)
- `file_name` (optional)

`target_image` is the image being changed. `reference_images` contains up to three style, text, layout, or identity references. The server sends the target first and the references afterward in WJ `input_images`.

## Privacy and data flow

The attachment is not uploaded to a public image host by `wj-mcp-server`. Its temporary ChatGPT download URL is sent immediately to the authenticated WJ image endpoint, whose existing image-edit pipeline downloads the bytes for the generation request. Do not log MCP tool arguments or WJ request bodies because temporary URLs grant short-lived access to private files.

## Deployment

No new environment variables are required. Rebuild and redeploy the service, then refresh or reconnect the ChatGPT plugin so ChatGPT scans the new `edit_image` tool schema.

```bash
docker compose up -d --build --force-recreate wj-mcp-server
docker compose logs -f wj-mcp-server
```

After reconnecting, attach images and ask, for example: `Use WJ to edit image one. Copy the name style from image two onto the board in image one.`
