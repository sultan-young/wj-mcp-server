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
  isTerminalImageJobToolFailure,
  type ImageAsset,
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

type GallerySlot =
  | { status: "ready"; asset: ImageAsset }
  | { status: "pending" }
  | { status: "failed"; error?: string };

declare global {
  interface Window {
    openai?: OpenAiBridge;
  }
}

const app = new App({ name: "WJ image result", version: APP_VERSION }, {});
const errorBox = requiredElement<HTMLDivElement>("error");
const result = requiredElement<HTMLElement>("result");
const mainImage = requiredElement<HTMLImageElement>("main-image");
const mainSkeleton = requiredElement<HTMLDivElement>("main-skeleton");
const mainFailed = requiredElement<HTMLDivElement>("main-failed");
const thumbs = requiredElement<HTMLElement>("thumbs");
const model = requiredElement<HTMLElement>("model");
const resolution = requiredElement<HTMLSpanElement>("resolution");
const stats = requiredElement<HTMLSpanElement>("stats");
const openButton = requiredElement<HTMLButtonElement>("open");

let current: ImageResult | undefined;
let slots: GallerySlot[] = [];
let activeIndex = 0;
let boundResultKey: string | undefined;
let renderedSlotKey: string | undefined;
let persistedCompletedKey: string | undefined;
let persistedInProgressJobId: string | undefined;
let pollInFlight: Promise<void> | undefined;
let compatibilityRestoreTimer: number | undefined;
let activeJobId: string | undefined;

createIcons({ icons: { ExternalLink } });

app.addEventListener("toolresult", (params) => {
  cancelCompatibilityRestore();
  void applyToolResult(params, true);
});

app.onhostcontextchanged = applyHostContext;

window.addEventListener("keydown", (event) => {
  if (slots.length < 2) return;
  if (event.key === "ArrowLeft") showIndex(activeIndex - 1);
  if (event.key === "ArrowRight") showIndex(activeIndex + 1);
});

openButton.addEventListener("click", async () => {
  const url = currentReadyAsset()?.url;
  if (url) await app.openLink({ url });
});

await app.connect();
applyHostContext(app.getHostContext());
void hydrateFromSource(window.openai?.widgetState, false);

window.addEventListener("openai:set_globals", (event) => {
  const globals = (event as CustomEvent<{ globals?: OpenAiBridge }>).detail?.globals;
  if (current || slots.length > 0) return;
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
    renderCompletedGallery(imageResult, persist);
    return;
  }

  if (record.isError) {
    if (!current && slots.every((slot) => slot.status !== "ready")) {
      showLost("图片结果暂时无法显示，请使用消息中的原图链接。");
    }
    return;
  }

  if (current || slots.length > 0) return;
  await executeRestorePlan(resolveRestorePlan(params), persist);
}

async function hydrateFromSource(source: unknown, persist: boolean): Promise<void> {
  if (current || slots.length > 0 || source === undefined) return;
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
      renderCompletedGallery(plan.imageResult, persist);
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

async function followStatusJob(job: ImageJob, persist: boolean, allowPoll: boolean): Promise<void> {
  if (!stillBoundToJob(job.jobId)) return;
  boundResultKey ??= getImageJobIdKey(job.jobId);
  activeJobId = job.jobId;

  const outcome = await applyJobSnapshot(job, persist);
  if (outcome === "done") return;
  if (persist) persistInProgress(job.jobId);
  if (allowPoll) await pollStatusUntilDone(job.jobId, persist);
}

async function applyJobSnapshot(job: ImageJob, persist: boolean): Promise<"continue" | "done"> {
  if (!imageJobMatchesBinding(boundResultKey, job.jobId) && boundResultKey !== undefined) {
    if (activeJobId !== job.jobId) return "done";
  }
  boundResultKey ??= getImageJobIdKey(job.jobId);

  renderJobGallery(job);

  const next = planAfterStatus(job);
  if (next.kind === "render") {
    if (bindImageResult(next.imageResult)) renderCompletedGallery(next.imageResult, persist);
    activeJobId = undefined;
    return "done";
  }
  if (next.kind === "lost") {
    if (!slots.some((slot) => slot.status === "ready")) {
      showLost(next.reason, persist, job.jobId);
    } else {
      showIndex(activeIndex);
    }
    activeJobId = undefined;
    return "done";
  }

  return "continue";
}

async function probeStatusThenFollow(jobId: string, persist: boolean): Promise<void> {
  if (!stillBoundToJob(jobId)) return;
  boundResultKey ??= getImageJobIdKey(jobId);
  activeJobId = jobId;
  showPendingGallery(jobId);
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
      renderCompletedGallery(imageResult, persist);
      return;
    }
    showLost("无法解析生图任务状态。", persist, jobId);
  } catch {
    showLost("查询生图任务失败，请刷新后重试。", persist, jobId);
  }
}

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
          if (bindImageResult(imageResult)) renderCompletedGallery(imageResult, persist);
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
  if (slots.some((slot) => slot.status === "ready")) {
    showIndex(activeIndex);
    return;
  }
  const cached = getImageResult(window.openai?.widgetState);
  if (cached && bindImageResult(cached)) {
    renderCompletedGallery(cached, false);
    return;
  }
  showLost(fallbackMessage, persist, activeJobId);
}

function showPendingGallery(jobId: string): void {
  const total = Math.max(slots.length, 1);
  slots = Array.from({ length: total }, () => ({ status: "pending" as const }));
  current = {
    jobId,
    model: current?.model ?? "WJ",
    assets: [],
  };
  paintGallery(true);
}

function renderJobGallery(job: ImageJob): void {
  const total = Math.max(
    1,
    job.progress?.total ?? 0,
    job.assets.length,
    (job.failures?.reduce((max, item) => Math.max(max, item.index + 1), 0) ?? 0),
  );
  const nextSlots = buildSlotsFromJob(job, total);

  const readyAssets = nextSlots
    .filter((slot): slot is { status: "ready"; asset: ImageAsset } => slot.status === "ready")
    .map((slot) => slot.asset);

  current = {
    jobId: job.jobId,
    model: job.model,
    resolution: job.resolution,
    aspectRatio: job.aspectRatio,
    durationMs: job.durationMs,
    assets: readyAssets,
    failureCount: job.failures?.length ?? 0,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
  };
  slots = nextSlots;
  paintGallery(false);
}

function renderCompletedGallery(data: ImageResult, persistCompletedSnapshot: boolean): void {
  activeJobId = undefined;
  current = data;
  slots = data.assets.map((asset) => ({ status: "ready" as const, asset }));
  paintGallery(true);
  if (persistCompletedSnapshot) {
    persistCompleted(data, true, getImageResultKey(data));
  }
}

function buildSlotsFromJob(job: ImageJob, total: number): GallerySlot[] {
  const assetByIndex = new Map<number, ImageAsset>();
  for (const [order, asset] of job.assets.entries()) {
    assetByIndex.set(asset.prompt_index ?? order, asset);
  }
  const failureByIndex = new Map((job.failures ?? []).map((failure) => [failure.index, failure.error]));

  return Array.from({ length: total }, (_, index) => {
    const asset = assetByIndex.get(index);
    if (asset) return { status: "ready" as const, asset };
    if (failureByIndex.has(index)) {
      return { status: "failed" as const, error: failureByIndex.get(index) };
    }
    return { status: "pending" as const };
  });
}

function paintGallery(resetIndex: boolean): void {
  const slotKey = slots.map((slot) => {
    if (slot.status === "ready") return `r:${slot.asset.url}`;
    if (slot.status === "failed") return `f:${slot.error ?? ""}`;
    return "p";
  }).join("|");

  const structureChanged = renderedSlotKey !== slotKey;
  renderedSlotKey = slotKey;

  if (structureChanged) {
    thumbs.replaceChildren();
    for (const [index, slot] of slots.entries()) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "thumb";
      button.title = slot.status === "ready"
        ? `选择第 ${index + 1} 张`
        : slot.status === "failed"
          ? `第 ${index + 1} 张失败`
          : `第 ${index + 1} 张生成中`;
      button.setAttribute("aria-label", button.title);

      if (slot.status === "ready") {
        const image = document.createElement("img");
        image.src = slot.asset.url;
        image.alt = `生成图片 ${index + 1}`;
        image.loading = index === 0 ? "eager" : "lazy";
        image.decoding = "async";
        image.referrerPolicy = "no-referrer";
        button.append(image);
      } else if (slot.status === "pending") {
        button.classList.add("is-pending");
        const skeleton = document.createElement("div");
        skeleton.className = "skeleton thumb-skeleton";
        button.append(skeleton);
      } else {
        button.classList.add("is-failed");
        button.textContent = "失败";
      }

      button.addEventListener("click", () => showIndex(index));
      thumbs.append(button);
    }
  }

  thumbs.hidden = slots.length < 2;
  errorBox.hidden = true;
  result.hidden = false;

  if (resetIndex || activeIndex >= slots.length) activeIndex = 0;
  // Prefer first ready slot on first paint when current selection is still pending.
  if (resetIndex) {
    const firstReady = slots.findIndex((slot) => slot.status === "ready");
    if (firstReady >= 0) activeIndex = firstReady;
  }
  showIndex(activeIndex);
}

function showIndex(nextIndex: number): void {
  if (!slots.length) return;
  const total = slots.length;
  activeIndex = ((nextIndex % total) + total) % total;
  const slot = slots[activeIndex];

  thumbs.querySelectorAll(".thumb").forEach((node, index) => {
    node.classList.toggle("is-active", index === activeIndex);
  });

  if (!slot || slot.status === "pending") {
    mainImage.hidden = true;
    mainImage.removeAttribute("src");
    mainFailed.hidden = true;
    mainSkeleton.hidden = false;
  } else if (slot.status === "failed") {
    mainImage.hidden = true;
    mainImage.removeAttribute("src");
    mainSkeleton.hidden = true;
    mainFailed.hidden = false;
    mainFailed.textContent = slot.error ?? `第 ${activeIndex + 1} 张生成失败`;
  } else {
    mainSkeleton.hidden = true;
    mainFailed.hidden = true;
    mainImage.hidden = false;
    mainImage.src = slot.asset.url;
    mainImage.alt = `WJ 生成图片 ${activeIndex + 1}`;
  }

  updateChrome();
}

function updateChrome(): void {
  const slot = slots[activeIndex];
  model.textContent = current?.model ?? "WJ";

  // Pixel size from the generated asset (API width/height), not request-time 2K / 1:1.
  resolution.textContent = slot?.status === "ready" && slot.asset.width && slot.asset.height
    ? `${slot.asset.width} * ${slot.asset.height}`
    : "";

  const duration = formatDuration(
    (slot?.status === "ready" ? slot.asset.duration_ms : undefined) ?? current?.durationMs,
  );
  stats.textContent = [
    slots.length > 0 ? `${activeIndex + 1}/${slots.length}` : undefined,
    duration,
  ].filter(Boolean).join(" · ");

  openButton.disabled = slot?.status !== "ready";
  errorBox.hidden = true;
  result.hidden = false;
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
    if (current || slots.length > 0 || boundResultKey) return;
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

function currentReadyAsset(): ImageAsset | undefined {
  const slot = slots[activeIndex];
  return slot?.status === "ready" ? slot.asset : undefined;
}

function showLost(message: string, persist = false, jobId?: string): void {
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
