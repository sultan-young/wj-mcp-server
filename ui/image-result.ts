import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { createIcons, Download, ExternalLink } from "lucide";

import { APP_VERSION } from "../src/version.js";
import {
  createPersistedImageState,
  getImageResult,
  getImageResultId,
  getImageResultIdKey,
  getImageResultKey,
  imageResultMatchesBinding,
  type ImageAsset,
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
const thumbs = requiredElement<HTMLElement>("thumbs");
const mainStage = requiredElement<HTMLButtonElement>("main-stage");
const mainImage = requiredElement<HTMLImageElement>("main-image");
const model = requiredElement<HTMLElement>("model");
const details = requiredElement<HTMLSpanElement>("details");
const openButton = requiredElement<HTMLButtonElement>("open");
const downloadButton = requiredElement<HTMLButtonElement>("download");
const lightbox = requiredElement<HTMLDivElement>("lightbox");
const lightboxImage = requiredElement<HTMLImageElement>("lightbox-image");
const lightboxClose = requiredElement<HTMLButtonElement>("lightbox-close");
let current: ImageResult | undefined;
let activeIndex = 0;
let boundResultKey: string | undefined;
let renderedResultKey: string | undefined;
let persistedResultKey: string | undefined;
let recoveryInFlight: Promise<void> | undefined;
let compatibilityRestoreTimer: number | undefined;

createIcons({ icons: { Download, ExternalLink } });

app.addEventListener("toolresult", (params) => {
  cancelCompatibilityRestore();
  const imageResult = getImageResult(params);
  if (params.isError || !imageResult) {
    if (!current && !params.isError) void recoverFromResultId(getImageResultId(params));
    else if (!current) showResultUnavailable();
    return;
  }
  if (!bindImageResult(imageResult)) return;
  render(imageResult, true);
});

app.onhostcontextchanged = applyHostContext;

mainStage.addEventListener("click", () => {
  const asset = currentAsset();
  if (asset) openLightbox(asset);
});

lightbox.addEventListener("click", (event) => {
  if (event.target === lightbox || event.target === lightboxClose) closeLightbox();
});

lightboxClose.addEventListener("click", closeLightbox);

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !lightbox.hidden) {
    closeLightbox();
    return;
  }
  if (!current || current.assets.length < 2) return;
  if (event.key === "ArrowLeft") showIndex(activeIndex - 1);
  if (event.key === "ArrowRight") showIndex(activeIndex + 1);
});

openButton.addEventListener("click", async () => {
  const url = currentAsset()?.url;
  if (url) await app.openLink({ url });
});

downloadButton.addEventListener("click", async () => {
  const asset = currentAsset();
  if (!asset) return;
  await app.downloadFile({
    contents: [
      {
        type: "resource_link",
        uri: asset.url,
        name: `wj-generated-image-${activeIndex + 1}`,
        title: `WJ 生成图片 ${activeIndex + 1}`,
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
  const stateResult = getImageResult(bridge.widgetState);
  if (stateResult && bindImageResult(stateResult)) {
    render(stateResult, false);
    return;
  }

  const stateResultId = getImageResultId(bridge.widgetState);
  if (stateResultId) {
    void recoverFromResultId(stateResultId);
    return;
  }

  scheduleCompatibilityRestore(bridge);
}

async function recoverFromResultId(resultId: string | undefined): Promise<void> {
  if (!resultId || current || recoveryInFlight || !bindResultId(resultId)) return;
  cancelCompatibilityRestore();
  recoveryInFlight = (async () => {
    try {
      if (current) return;
      const restored = await app.callServerTool({
        name: "get_image_result",
        arguments: { result_id: resultId },
      });
      if (current) return;
      const imageResult = getImageResult(restored);
      if (imageResult && bindImageResult(imageResult)) render(imageResult, true);
      else if (!current) showResultUnavailable();
    } catch {
      if (!current) showResultUnavailable();
    } finally {
      recoveryInFlight = undefined;
    }
  })();
  await recoveryInFlight;
}

function render(data: ImageResult, persist: boolean): void {
  const resultKey = getImageResultKey(data);
  current = data;

  if (renderedResultKey === resultKey) {
    updateChrome(data);
    maybePersist(data, persist, resultKey);
    return;
  }

  renderedResultKey = resultKey;
  activeIndex = 0;
  thumbs.replaceChildren();

  const multi = data.assets.length > 1;
  thumbs.hidden = !multi;

  if (multi) {
    for (const [index, asset] of data.assets.entries()) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "thumb";
      button.title = `切换到第 ${index + 1} 张`;
      button.setAttribute("aria-label", `切换到第 ${index + 1} 张`);
      const image = document.createElement("img");
      image.src = asset.url;
      image.alt = `缩略图 ${index + 1}`;
      image.loading = index === 0 ? "eager" : "lazy";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      button.append(image);
      button.addEventListener("click", () => showIndex(index));
      thumbs.append(button);
    }
  }

  showIndex(0);
  updateChrome(data);
  maybePersist(data, persist, resultKey);
}

function showIndex(nextIndex: number): void {
  if (!current?.assets.length) return;
  const total = current.assets.length;
  activeIndex = ((nextIndex % total) + total) % total;
  const asset = current.assets[activeIndex]!;
  mainImage.src = asset.url;
  mainImage.alt = `WJ 生成图片 ${activeIndex + 1}`;
  if (asset.width) mainImage.width = asset.width;
  else mainImage.removeAttribute("width");
  if (asset.height) mainImage.height = asset.height;
  else mainImage.removeAttribute("height");

  thumbs.querySelectorAll(".thumb").forEach((node, index) => {
    node.classList.toggle("is-active", index === activeIndex);
  });

  updateChrome(current);
  if (!lightbox.hidden) openLightbox(asset);
}

function openLightbox(asset: ImageAsset): void {
  lightboxImage.src = asset.url;
  lightboxImage.alt = `大图预览 ${activeIndex + 1}`;
  lightbox.hidden = false;
}

function closeLightbox(): void {
  lightbox.hidden = true;
  lightboxImage.removeAttribute("src");
}

function maybePersist(data: ImageResult, persist: boolean, resultKey: string): void {
  if (!persist || persistedResultKey === resultKey) return;
  persistedResultKey = resultKey;
  window.openai?.setWidgetState?.(createPersistedImageState(data));
}

function bindImageResult(imageResult: ImageResult): boolean {
  if (!imageResultMatchesBinding(boundResultKey, imageResult)) return false;
  boundResultKey ??= getImageResultKey(imageResult);
  return true;
}

function bindResultId(resultId: string): boolean {
  const resultKey = getImageResultIdKey(resultId);
  if (boundResultKey && boundResultKey !== resultKey) return false;
  boundResultKey ??= resultKey;
  return true;
}

function scheduleCompatibilityRestore(bridge: OpenAiBridge): void {
  cancelCompatibilityRestore();
  compatibilityRestoreTimer = window.setTimeout(() => {
    compatibilityRestoreTimer = undefined;
    if (current || boundResultKey) return;
    const sources = [bridge.toolOutput, bridge.toolResponseMetadata];
    const restoredResult = sources.map(getImageResult).find((value): value is ImageResult => value !== undefined);
    if (restoredResult && bindImageResult(restoredResult)) {
      render(restoredResult, false);
      return;
    }
    void recoverFromResultId(sources.map(getImageResultId).find((value): value is string => value !== undefined));
  }, 750);
}

function cancelCompatibilityRestore(): void {
  if (compatibilityRestoreTimer === undefined) return;
  window.clearTimeout(compatibilityRestoreTimer);
  compatibilityRestoreTimer = undefined;
}

function updateChrome(data: ImageResult): void {
  const total = data.assets.length;
  const asset = data.assets[activeIndex];
  model.textContent = data.model;
  details.textContent = [
    data.resolution,
    data.aspectRatio,
    total > 1 ? `${activeIndex + 1}/${total}` : undefined,
    asset?.width && asset?.height ? `${asset.width}×${asset.height}` : undefined,
    formatDuration(data.durationMs),
  ].filter(Boolean).join(" · ");
  loading.hidden = true;
  errorBox.hidden = true;
  result.hidden = false;
}

function currentAsset() {
  return current?.assets[activeIndex];
}

function showResultUnavailable(): void {
  loading.hidden = true;
  result.hidden = true;
  closeLightbox();
  errorBox.textContent = "图片结果暂时无法恢复，请使用消息中的原图链接。";
  errorBox.hidden = false;
}

function applyHostContext(context: ReturnType<App["getHostContext"]>): void {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
}

function formatDuration(durationMs?: number): string | undefined {
  if (durationMs === undefined) return undefined;
  return `耗时 ${(durationMs / 1000).toFixed(durationMs >= 10_000 ? 0 : 1)}s`;
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}
