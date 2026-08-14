import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { createIcons, ExternalLink } from "lucide";

import { APP_VERSION } from "../src/version.js";
import {
  createPersistedCompletedState,
  createPersistedInProgressState,
  createPersistedLostState,
  planAfterStatus,
  resolveRestorePlan,
  type RestorePlan,
} from "./image-result-lifecycle.js";
import {
  getImageJob,
  getImageJobId,
  getImageJobIdKey,
  getImageResult,
  getImageResultKey,
  imageJobMatchesBinding,
  isTerminalImageJobStatus,
  isTerminalImageJobToolFailure,
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

let current: ImageResult | undefined;
let activeIndex = 0;
let boundResultKey: string | undefined;
let renderedResultKey: string | undefined;
let persistedCompletedKey: string | undefined;
let persistedInProgressJobId: string | undefined;
let pollInFlight: Promise<void> | undefined;
let compatibilityRestoreTimer: number | undefined;
let activeJobId: string | undefined;

createIcons({ icons: { ExternalLink } });

mainImage.draggable = false;
mainImage.addEventListener("dragstart", (event) => event.preventDefault());
thumbs.addEventListener("dragstart", (event) => {
  if (event.target instanceof HTMLImageElement) event.preventDefault();
});

app.addEventListener("toolresult", (params) => {
  cancelCompatibilityRestore();
  void applyToolResult(params, true);
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

await app.connect();
applyHostContext(app.getHostContext());
void hydrateFromSource(window.openai?.widgetState, false);

window.addEventListener("openai:set_globals", (event) => {
  const globals = (event as CustomEvent<{ globals?: OpenAiBridge }>).detail?.globals;
  if (current) return;
  void hydrateFromSource((globals ?? window.openai)?.widgetState, false);
});

async function applyToolResult(params: unknown, persist: boolean): Promise<void> {
  const record = params && typeof params === "object" ? params as { isError?: boolean } : {};
  const job = getImageJob(params);
  if (job) {
    await followStatusJob(job, persist, true);
    return;
  }

  const imageResult = getImageResult(params);
  if (imageResult) {
    if (!bindImageResult(imageResult)) return;
    renderAssets(imageResult, persist);
    return;
  }

  if (record.isError) {
    if (!current) showLost("图片结果暂时无法显示，请使用消息中的原图链接。");
    return;
  }

  if (current) return;
  await executeRestorePlan(resolveRestorePlan(params), persist);
}

async function hydrateFromSource(source: unknown, persist: boolean): Promise<void> {
  if (current || source === undefined) return;
  const plan = resolveRestorePlan(source);
  if (plan.kind === "none") {
    scheduleCompatibilityRestore();
    return;
  }
  await executeRestorePlan(plan, persist);
}

async function executeRestorePlan(plan: RestorePlan, persist: boolean): Promise<void> {
  switch (plan.kind) {
    case "render":
      if (!bindImageResult(plan.imageResult)) return;
      renderAssets(plan.imageResult, persist);
      return;
    case "probe_status":
      await probeStatusThenFollow(plan.jobId, persist);
      return;
    case "lost":
      showLost(plan.reason, persist);
      return;
    case "none":
      return;
  }
}

/** Live path after generate_image / status snapshot. */
async function followStatusJob(job: ImageJob, persist: boolean, allowPoll: boolean): Promise<void> {
  if (!stillBoundToJob(job.jobId)) return;
  boundResultKey ??= getImageJobIdKey(job.jobId);
  activeJobId = job.jobId;

  const outcome = await applyJobSnapshot(job, persist);
  if (outcome === "done") return;
  if (persist) persistInProgress(job.jobId);
  if (allowPoll) await pollStatusUntilDone(job.jobId, persist);
}

/** Apply a get_image_job_result snapshot: paint progressive assets; stop only on terminal status. */
async function applyJobSnapshot(job: ImageJob, persist: boolean): Promise<"continue" | "done"> {
  const partial = jobToImageResult(job);
  if (partial && bindImageResult(partial)) {
    renderAssets(partial, isTerminalImageJobStatus(job.status) && persist);
  }

  const next = planAfterStatus(job);
  if (next.kind === "render") {
    if (bindImageResult(next.imageResult)) renderAssets(next.imageResult, persist);
    activeJobId = undefined;
    return "done";
  }
  if (next.kind === "lost") {
    if (!partial) showLost(next.reason, persist, job.jobId);
    activeJobId = undefined;
    return "done";
  }

  showProgressChrome(job);
  return "continue";
}

/**
 * Refresh / remount: one status check, then either show result,
 * mark lost, or continue polling only if still in progress.
 */
async function probeStatusThenFollow(jobId: string, persist: boolean): Promise<void> {
  if (!stillBoundToJob(jobId)) return;
  boundResultKey ??= getImageJobIdKey(jobId);
  activeJobId = jobId;
  showInProgress("running");
  if (persist) persistInProgress(jobId);

  try {
    const polled = await app.callServerTool({
      name: "get_image_job_result",
      arguments: { job_id: jobId },
    });
    const terminalFailure = isTerminalImageJobToolFailure(polled);
    if (terminalFailure) {
      await recoverAfterMissingJob(persist, terminalFailure);
      return;
    }
    const resolved = getImageJob(polled);
    if (resolved) {
      await followStatusJob(resolved, persist, true);
      return;
    }
    const imageResult = getImageResult(polled);
    if (imageResult && bindImageResult(imageResult)) {
      renderAssets(imageResult, persist);
      return;
    }
    showLost("无法解析生图任务状态。", persist, jobId);
  } catch {
    showLost("查询生图任务失败，请刷新后重试。", persist, jobId);
  }
}

/** Poll after each response returns, then wait 2s before the next request. */
async function pollStatusUntilDone(jobId: string, persist: boolean): Promise<void> {
  if (!stillBoundToJob(jobId)) return;
  if (pollInFlight) return;

  const pollGapMs = 2_000;
  pollInFlight = (async () => {
    const deadline = Date.now() + 20 * 60 * 1000;
    let transientFailures = 0;
    while (Date.now() < deadline) {
      if (!stillBoundToJob(jobId) || activeJobId !== jobId) return;
      try {
        const polled = await app.callServerTool({
          name: "get_image_job_result",
          arguments: { job_id: jobId },
        });
        const terminalFailure = isTerminalImageJobToolFailure(polled);
        if (terminalFailure) {
          await recoverAfterMissingJob(persist, terminalFailure);
          return;
        }
        const resolved = getImageJob(polled);
        if (resolved) {
          transientFailures = 0;
          if (await applyJobSnapshot(resolved, persist) === "done") return;
          await sleep(pollGapMs);
          continue;
        }
        const imageResult = getImageResult(polled);
        if (imageResult) {
          if (bindImageResult(imageResult)) renderAssets(imageResult, persist);
          activeJobId = undefined;
          return;
        }
        transientFailures += 1;
        if (transientFailures >= 3) {
          showLost("无法解析生图任务状态。", persist, jobId);
          return;
        }
        await sleep(pollGapMs);
      } catch {
        transientFailures += 1;
        if (transientFailures >= 8) {
          showLost("查询生图任务多次失败，请刷新后重试。", persist, jobId);
          return;
        }
        await sleep(pollGapMs);
      }
    }
    showLost("生图任务超过 20 分钟仍未完成。", persist, jobId);
  })().finally(() => {
    pollInFlight = undefined;
  });

  await pollInFlight;
}

async function recoverAfterMissingJob(persist: boolean, fallbackMessage: string): Promise<void> {
  if (current) return;
  const cached = getImageResult(window.openai?.widgetState);
  if (cached && bindImageResult(cached)) {
    renderAssets(cached, false);
    return;
  }
  showLost(fallbackMessage, persist, activeJobId);
}

function renderAssets(data: ImageResult, persistCompletedSnapshot: boolean): void {
  const resultKey = getImageResultKey(data);
  const previousAssets = current?.assets ?? [];
  const previousCount = previousAssets.length;
  current = data;

  if (renderedResultKey === resultKey) {
    updateChrome(data);
    if (persistCompletedSnapshot) persistCompleted(data, true, resultKey);
    return;
  }

  const appendOnly = renderedResultKey !== undefined
    && previousCount > 0
    && data.assets.length >= previousCount
    && previousAssets.every((asset, index) => asset.url === data.assets[index]?.url);

  renderedResultKey = resultKey;
  if (!appendOnly) {
    activeIndex = 0;
    thumbs.replaceChildren();
  }
  thumbs.hidden = data.assets.length < 2;

  const startIndex = appendOnly ? previousCount : 0;
  for (let index = startIndex; index < data.assets.length; index += 1) {
    const asset = data.assets[index];
    if (!asset) continue;
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
    image.draggable = false;
    button.append(image);
    button.addEventListener("click", () => showIndex(index));
    thumbs.append(button);
  }

  if (!appendOnly || previousCount === 0) showIndex(0);
  else updateChrome(data);
  if (persistCompletedSnapshot) persistCompleted(data, true, resultKey);
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

function persistCompleted(data: ImageResult, persist: boolean, resultKey: string): void {
  if (!persist || persistedCompletedKey === resultKey) return;
  const jobId = data.jobId ?? activeJobId ?? getImageJobId(window.openai?.widgetState);
  if (!jobId) return;
  persistedCompletedKey = resultKey;
  window.openai?.setWidgetState?.(createPersistedCompletedState({ ...data, jobId }, jobId));
}

function persistInProgress(jobId: string): void {
  if (persistedCompletedKey || persistedInProgressJobId === jobId) return;
  persistedInProgressJobId = jobId;
  window.openai?.setWidgetState?.(createPersistedInProgressState(jobId));
}

function stillBoundToJob(jobId: string): boolean {
  if (activeJobId !== undefined && activeJobId !== jobId) return false;
  if (boundResultKey === undefined) return true;
  if (imageJobMatchesBinding(boundResultKey, jobId)) return true;
  return activeJobId === jobId;
}

function bindImageResult(imageResult: ImageResult): boolean {
  if (imageResult.jobId) {
    if (
      boundResultKey === undefined
      || imageJobMatchesBinding(boundResultKey, imageResult.jobId)
      || activeJobId === imageResult.jobId
    ) {
      boundResultKey = getImageJobIdKey(imageResult.jobId);
      return true;
    }
    return false;
  }
  const nextKey = getImageResultKey(imageResult);
  if (boundResultKey === undefined || boundResultKey === nextKey) {
    boundResultKey = nextKey;
    return true;
  }
  if (boundResultKey.startsWith("assets:") && nextKey.startsWith("assets:")) {
    const prevUrls = boundResultKey.slice("assets:".length).split("\n").filter(Boolean);
    const nextUrls = new Set(imageResult.assets.map((asset) => asset.url));
    if (prevUrls.every((url) => nextUrls.has(url))) {
      boundResultKey = nextKey;
      return true;
    }
  }
  return false;
}

function scheduleCompatibilityRestore(): void {
  cancelCompatibilityRestore();
  compatibilityRestoreTimer = window.setTimeout(() => {
    compatibilityRestoreTimer = undefined;
    if (current || boundResultKey) return;
    const bridge = window.openai;
    const sources = [bridge?.toolOutput, bridge?.toolResponseMetadata];
    for (const source of sources) {
      const plan = resolveRestorePlan(source);
      if (plan.kind !== "none") {
        void executeRestorePlan(plan, false);
        return;
      }
    }
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
    data.failureCount ? `失败 ${data.failureCount}` : undefined,
  ].filter(Boolean).join(" · ");
  errorBox.hidden = true;
  result.hidden = false;
  if (activeJobId) {
    loading.hidden = false;
  } else {
    loading.hidden = true;
  }
}

function currentAsset() {
  return current?.assets[activeIndex];
}

function showProgressChrome(job: ImageJob): void {
  const progress = job.progress;
  const progressLabel = progress
    ? `${progress.succeeded}/${progress.total} 成功`
    + (progress.failed ? ` · ${progress.failed} 失败` : "")
    + (progress.pending ? ` · ${progress.pending} 待完成` : "")
    : job.status;
  loading.hidden = false;
  errorBox.hidden = true;
  loadingText.textContent = current
    ? `WJ 继续生成中（${progressLabel}）…`
    : `WJ 正在生成图片（${progressLabel}）…`;
  if (!current) result.hidden = true;
}

function showInProgress(status: string): void {
  loading.hidden = false;
  errorBox.hidden = true;
  if (!current) result.hidden = true;
  loadingText.textContent = `WJ 正在生成图片（${status}）…`;
}

function showLost(
  message: string,
  persist = false,
  jobId?: string,
): void {
  loading.hidden = true;
  result.hidden = true;
  errorBox.textContent = message;
  errorBox.hidden = false;
  if (persist) {
    window.openai?.setWidgetState?.(createPersistedLostState(message, jobId));
  }
}

function applyHostContext(context: ReturnType<App["getHostContext"]>): void {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
}

function formatDuration(durationMs?: number): string | undefined {
  if (durationMs === undefined) return undefined;
  return `耗时 ${(durationMs / 1000).toFixed(durationMs >= 10_000 ? 0 : 1)}s`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}
