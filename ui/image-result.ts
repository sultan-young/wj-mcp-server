import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { createIcons, Download, ExternalLink } from "lucide";

import { APP_VERSION } from "../src/version.js";
import {
  createPersistedImageState,
  createPersistedJobState,
  getImageJob,
  getImageJobId,
  getImageJobIdKey,
  getImageResult,
  getImageResultId,
  getImageResultIdKey,
  getImageResultKey,
  imageJobMatchesBinding,
  imageResultMatchesBinding,
  jobToImageResult,
  type ImageJob,
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
const loadingText = requiredElement<HTMLSpanElement>("loading-text");
const errorBox = requiredElement<HTMLDivElement>("error");
const result = requiredElement<HTMLElement>("result");
const mainImage = requiredElement<HTMLImageElement>("main-image");
const thumbs = requiredElement<HTMLElement>("thumbs");
const model = requiredElement<HTMLElement>("model");
const details = requiredElement<HTMLSpanElement>("details");
const openButton = requiredElement<HTMLButtonElement>("open");
const downloadButton = requiredElement<HTMLButtonElement>("download");
let current: ImageResult | undefined;
let activeIndex = 0;
let boundResultKey: string | undefined;
let renderedResultKey: string | undefined;
let persistedResultKey: string | undefined;
let recoveryInFlight: Promise<void> | undefined;
let pollInFlight: Promise<void> | undefined;
let compatibilityRestoreTimer: number | undefined;
let activeJobId: string | undefined;

createIcons({ icons: { Download, ExternalLink } });

app.addEventListener("toolresult", (params) => {
  cancelCompatibilityRestore();
  const job = getImageJob(params);
  if (job) {
    void handleJobUpdate(job, true);
    return;
  }
  const imageResult = getImageResult(params);
  if (params.isError || !imageResult) {
    if (!current && !params.isError) {
      const jobId = getImageJobId(params);
      if (jobId) void pollJobUntilDone(jobId, true);
      else void recoverFromResultId(getImageResultId(params));
    } else if (!current) showResultUnavailable();
    return;
  }
  if (!bindImageResult(imageResult)) return;
  render(imageResult, true);
});

app.onhostcontextchanged = applyHostContext;

window.addEventListener("keydown", (event) => {
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
  const filename = `wj-generated-image-${activeIndex + 1}${extensionForMime(asset.mime_type)}`;
  const mimeType = asset.mime_type ?? "image/png";

  // ChatGPT often does not implement host downloadFile (-32601); fall back to blob download.
  try {
    const result = await app.downloadFile({
      contents: [
        {
          type: "resource_link",
          uri: asset.url,
          name: filename,
          title: `WJ 生成图片 ${activeIndex + 1}`,
          mimeType,
        },
      ],
    });
    if (!result?.isError) return;
  } catch {
    // continue to browser fallback
  }

  try {
    await downloadViaBrowser(asset.url, filename, mimeType);
  } catch {
    await app.openLink({ url: asset.url });
  }
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

  const stateJobId = getImageJobId(bridge.widgetState);
  if (stateJobId) {
    void pollJobUntilDone(stateJobId, false);
    return;
  }

  const stateResultId = getImageResultId(bridge.widgetState);
  if (stateResultId) {
    void recoverFromResultId(stateResultId);
    return;
  }

  scheduleCompatibilityRestore(bridge);
}

async function handleJobUpdate(job: ImageJob, persist: boolean): Promise<void> {
  if (!imageJobMatchesBinding(boundResultKey, job.jobId)) return;
  boundResultKey ??= getImageJobIdKey(job.jobId);
  activeJobId = job.jobId;

  if (job.status === "completed") {
    const imageResult = jobToImageResult(job);
    if (imageResult) {
      render(imageResult, persist);
      return;
    }
  }

  if (job.status === "failed" || job.status === "timed_out") {
    showJobFailed(job.error ?? `任务 ${job.status}`);
    return;
  }

  showJobLoading(job);
  if (persist) window.openai?.setWidgetState?.(createPersistedJobState(job.jobId));
  await pollJobUntilDone(job.jobId, persist);
}

async function pollJobUntilDone(jobId: string, persist: boolean): Promise<void> {
  if (!imageJobMatchesBinding(boundResultKey, jobId)) return;
  boundResultKey ??= getImageJobIdKey(jobId);
  activeJobId = jobId;
  if (pollInFlight) return;

  pollInFlight = (async () => {
    showJobLoading({ jobId, status: "running", model: "WJ" });
    const deadline = Date.now() + 20 * 60 * 1000;
    while (Date.now() < deadline) {
      try {
        const polled = await app.callServerTool({
          name: "get_image_job",
          arguments: { job_id: jobId, wait_ms: 45_000 },
        });
        const resolved = getImageJob(polled);
        if (!resolved) {
          const imageResult = getImageResult(polled);
          if (imageResult) {
            render(imageResult, persist);
            return;
          }
          continue;
        }
        if (resolved.status === "completed") {
          const imageResult = jobToImageResult(resolved);
          if (imageResult) {
            render(imageResult, persist);
            return;
          }
        }
        if (resolved.status === "failed" || resolved.status === "timed_out") {
          showJobFailed(resolved.error ?? `任务 ${resolved.status}`);
          return;
        }
        showJobLoading(resolved);
        if (persist) window.openai?.setWidgetState?.(createPersistedJobState(jobId));
      } catch {
        await sleep(2_000);
      }
    }
    showJobFailed("生图任务超过 20 分钟仍未完成。");
  })().finally(() => {
    pollInFlight = undefined;
  });

  await pollInFlight;
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
  thumbs.hidden = data.assets.length < 2;

  for (const [index, asset] of data.assets.entries()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "thumb";
    button.title = `选择第 ${index + 1} 张`;
    button.setAttribute("aria-label", `选择第 ${index + 1} 张`);
    const image = document.createElement("img");
    image.src = asset.url;
    image.alt = `生成图片 ${index + 1}`;
    image.loading = index === 0 ? "eager" : "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    button.append(image);
    button.addEventListener("click", () => showIndex(index));
    thumbs.append(button);
  }

  showIndex(0);
  updateChrome(data);
  maybePersist(data, persist, resultKey);
}

function showIndex(nextIndex: number): void {
  if (!current?.assets.length) return;
  const total = current.assets.length;
  activeIndex = ((nextIndex % total) + total) % total;
  const asset = current.assets[activeIndex];

  if (asset) {
    mainImage.src = asset.url;
    mainImage.alt = `WJ 生成图片 ${activeIndex + 1}`;
  }

  thumbs.querySelectorAll(".thumb").forEach((node, index) => {
    node.classList.toggle("is-active", index === activeIndex);
  });

  updateChrome(current);
}

function maybePersist(data: ImageResult, persist: boolean, resultKey: string): void {
  if (!persist || persistedResultKey === resultKey) return;
  persistedResultKey = resultKey;
  if (activeJobId) window.openai?.setWidgetState?.(createPersistedJobState(activeJobId, data));
  else window.openai?.setWidgetState?.(createPersistedImageState(data));
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
    const restoredJob = sources.map(getImageJob).find((value): value is ImageJob => value !== undefined);
    if (restoredJob) {
      void handleJobUpdate(restoredJob, false);
      return;
    }
    const restoredResult = sources.map(getImageResult).find((value): value is ImageResult => value !== undefined);
    if (restoredResult && bindImageResult(restoredResult)) {
      render(restoredResult, false);
      return;
    }
    const jobId = sources.map(getImageJobId).find((value): value is string => value !== undefined);
    if (jobId) {
      void pollJobUntilDone(jobId, false);
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
    formatDuration(asset?.duration_ms ?? data.durationMs),
  ].filter(Boolean).join(" · ");
  loading.hidden = true;
  errorBox.hidden = true;
  result.hidden = false;
}

function currentAsset() {
  return current?.assets[activeIndex];
}

function showJobLoading(job: Pick<ImageJob, "jobId" | "status" | "model">): void {
  loading.hidden = false;
  errorBox.hidden = true;
  result.hidden = true;
  loadingText.textContent = `WJ 正在生成图片（${job.status}）…`;
}

function showJobFailed(message: string): void {
  loading.hidden = true;
  result.hidden = true;
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function showResultUnavailable(): void {
  loading.hidden = true;
  result.hidden = true;
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

async function downloadViaBrowser(url: string, filename: string, mimeType: string): Promise<void> {
  const response = await fetch(url, { mode: "cors", credentials: "omit" });
  if (!response.ok) throw new Error(`Download fetch failed (${response.status})`);
  const blob = await response.blob();
  const fileBlob = blob.type ? blob : new Blob([blob], { type: mimeType });
  const objectUrl = URL.createObjectURL(fileBlob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  }
}

function extensionForMime(mimeType: string | undefined): string {
  if (!mimeType) return ".png";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return ".jpg";
  if (mimeType.includes("webp")) return ".webp";
  if (mimeType.includes("gif")) return ".gif";
  return ".png";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}
