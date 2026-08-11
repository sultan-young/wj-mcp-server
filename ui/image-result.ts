import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { createIcons, Download, ExternalLink } from "lucide";

import "./styles.css";

type ImageAsset = {
  url: string;
  mime_type?: string;
  width?: number;
  height?: number;
};

type ImageResult = {
  model: string;
  resolution?: string;
  aspectRatio?: string;
  durationMs?: number;
  assets: ImageAsset[];
};

const app = new App({ name: "WJ image result", version: "0.1.0" }, {});
const loading = requiredElement<HTMLDivElement>("loading");
const errorBox = requiredElement<HTMLDivElement>("error");
const result = requiredElement<HTMLElement>("result");
const gallery = requiredElement<HTMLDivElement>("gallery");
const model = requiredElement<HTMLElement>("model");
const details = requiredElement<HTMLSpanElement>("details");
const openButton = requiredElement<HTMLButtonElement>("open");
const downloadButton = requiredElement<HTMLButtonElement>("download");
let current: ImageResult | undefined;

createIcons({ icons: { Download, ExternalLink } });

app.addEventListener("toolresult", (params) => {
  if (params.isError || !isImageResult(params.structuredContent)) {
    showError();
    return;
  }
  render(params.structuredContent);
});

app.onhostcontextchanged = applyHostContext;

openButton.addEventListener("click", async () => {
  const url = current?.assets[0]?.url;
  if (url) await app.openLink({ url });
});

downloadButton.addEventListener("click", async () => {
  const asset = current?.assets[0];
  if (!asset) return;
  await app.downloadFile({
    contents: [
      {
        type: "resource_link",
        uri: asset.url,
        name: "wj-generated-image",
        title: "WJ 生成图片",
        mimeType: asset.mime_type ?? "image/png",
      },
    ],
  });
});

await app.connect();
applyHostContext(app.getHostContext());

function render(data: ImageResult): void {
  current = data;
  gallery.replaceChildren();

  for (const [index, asset] of data.assets.entries()) {
    const image = document.createElement("img");
    image.src = asset.url;
    image.alt = `WJ 生成图片 ${index + 1}`;
    image.loading = index === 0 ? "eager" : "lazy";
    image.decoding = "async";
    if (asset.width) image.width = asset.width;
    if (asset.height) image.height = asset.height;
    image.addEventListener("error", showError, { once: true });
    gallery.append(image);
  }

  model.textContent = data.model;
  details.textContent = [data.resolution, data.aspectRatio, formatDuration(data.durationMs)].filter(Boolean).join(" · ");
  loading.hidden = true;
  errorBox.hidden = true;
  result.hidden = false;
}

function showError(): void {
  loading.hidden = true;
  result.hidden = true;
  errorBox.hidden = false;
}

function isImageResult(value: unknown): value is ImageResult {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ImageResult>;
  return typeof record.model === "string"
    && Array.isArray(record.assets)
    && record.assets.length > 0
    && record.assets.every((asset) => asset && typeof asset.url === "string" && asset.url.startsWith("https://"));
}

function applyHostContext(context: ReturnType<App["getHostContext"]>): void {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
}

function formatDuration(durationMs?: number): string | undefined {
  if (durationMs === undefined) return undefined;
  return `${(durationMs / 1000).toFixed(durationMs >= 10_000 ? 0 : 1)}s`;
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}
