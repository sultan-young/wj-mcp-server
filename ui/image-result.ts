import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { createIcons, Download, ExternalLink } from "lucide";

import { APP_VERSION } from "../src/version.js";
import {
  createPersistedImageState,
  getImageResult,
  getImageResultId,
  type ImageResult,
} from "./image-result-state.js";
import "./styles.css";

type OpenAiBridge = {
  toolOutput?: unknown;
  toolResponseMetadata?: unknown;
  widgetState?: unknown;
  setWidgetState?: (state: unknown) => void;
};

declare global {
  interface Window {
    openai?: OpenAiBridge;
  }
}

const app = new App({ name: "WJ image result", version: APP_VERSION }, {});
const loading = requiredElement<HTMLDivElement>("loading");
const errorBox = requiredElement<HTMLDivElement>("error");
const result = requiredElement<HTMLElement>("result");
const gallery = requiredElement<HTMLDivElement>("gallery");
const model = requiredElement<HTMLElement>("model");
const details = requiredElement<HTMLSpanElement>("details");
const openButton = requiredElement<HTMLButtonElement>("open");
const downloadButton = requiredElement<HTMLButtonElement>("download");
let current: ImageResult | undefined;
let recoveryInFlight: Promise<void> | undefined;

createIcons({ icons: { Download, ExternalLink } });

app.addEventListener("toolresult", (params) => {
  const imageResult = getImageResult(params);
  if (params.isError || !imageResult) {
    if (!current && !params.isError) void recoverFromResultId(getImageResultId(params));
    else if (!current) showResultUnavailable();
    return;
  }
  render(imageResult, true);
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
restoreFromOpenAiGlobals(window.openai);

window.addEventListener("openai:set_globals", (event) => {
  const globals = (event as CustomEvent<{ globals?: OpenAiBridge }>).detail?.globals;
  restoreFromOpenAiGlobals(globals ?? window.openai);
});

function restoreFromOpenAiGlobals(bridge: OpenAiBridge | undefined): void {
  if (current || !bridge) return;
  const sources = [bridge.toolOutput, bridge.toolResponseMetadata, bridge.widgetState];
  const restoredResult = sources.map(getImageResult).find(Boolean);
  if (restoredResult) render(restoredResult, false);
  else void recoverFromResultId(sources.map(getImageResultId).find(Boolean));
}

async function recoverFromResultId(resultId: string | undefined): Promise<void> {
  if (!resultId || current || recoveryInFlight) return;
  recoveryInFlight = (async () => {
    try {
      const restored = await app.callServerTool({
        name: "get_image_result",
        arguments: { result_id: resultId },
      });
      const imageResult = getImageResult(restored);
      if (imageResult) render(imageResult, true);
      else showResultUnavailable();
    } catch {
      showResultUnavailable();
    } finally {
      recoveryInFlight = undefined;
    }
  })();
  await recoveryInFlight;
}

function render(data: ImageResult, persist: boolean): void {
  current = data;
  gallery.replaceChildren();

  for (const [index, asset] of data.assets.entries()) {
    const image = document.createElement("img");
    image.src = asset.url;
    image.alt = `WJ 生成图片 ${index + 1}`;
    image.loading = index === 0 ? "eager" : "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    if (asset.width) image.width = asset.width;
    if (asset.height) image.height = asset.height;
    image.addEventListener("error", () => showImageLoadError(image), { once: true });
    gallery.append(image);
  }

  model.textContent = data.model;
  details.textContent = [data.resolution, data.aspectRatio, formatDuration(data.durationMs)].filter(Boolean).join(" · ");
  loading.hidden = true;
  errorBox.hidden = true;
  result.hidden = false;

  if (persist) window.openai?.setWidgetState?.(createPersistedImageState(data));
}

function showResultUnavailable(): void {
  loading.hidden = true;
  result.hidden = true;
  errorBox.textContent = "图片结果暂时无法恢复，请重新生成。";
  errorBox.hidden = false;
}

function showImageLoadError(image: HTMLImageElement): void {
  image.hidden = true;
  loading.hidden = true;
  result.hidden = false;
  errorBox.textContent = "图片加载失败，你仍可使用下方的“打开原图”按钮。";
  errorBox.hidden = false;
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
