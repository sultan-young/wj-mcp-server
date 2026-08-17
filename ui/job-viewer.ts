import "./job-viewer.css";

type PublicJobItem = {
  index: number;
  prompt: string;
  status: "ready" | "failed" | "pending";
  error?: string;
  asset?: {
    url: string;
    mime_type?: string;
    width?: number;
    height?: number;
    duration_ms?: number;
  };
};

type PublicImageJobView = {
  jobId: string;
  status: string;
  model: string;
  resolution: string;
  aspectRatio: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  error?: string;
  durationMs?: number;
  progress: {
    total: number;
    succeeded: number;
    failed: number;
    pending: number;
  };
  items: PublicJobItem[];
};

const form = requiredElement<HTMLFormElement>("lookup-form");
const jobInput = requiredElement<HTMLInputElement>("job-id");
const statusEl = requiredElement<HTMLParagraphElement>("status");
const resultEl = requiredElement<HTMLElement>("result");
const gallery = requiredElement<HTMLDivElement>("gallery");
const selectAll = requiredElement<HTMLInputElement>("select-all");
const downloadSelected = requiredElement<HTMLButtonElement>("download-selected");
const metaModel = requiredElement<HTMLElement>("meta-model");
const metaStatus = requiredElement<HTMLElement>("meta-status");
const metaSpec = requiredElement<HTMLElement>("meta-spec");
const metaJob = requiredElement<HTMLElement>("meta-job");

let current: PublicImageJobView | undefined;

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const jobId = normalizeJobId(jobInput.value);
  if (!jobId) {
    showStatus("请输入有效的 Job ID（wj_job_…）。", true);
    return;
  }
  void lookup(jobId, true);
});

selectAll.addEventListener("change", () => {
  for (const checkbox of gallery.querySelectorAll<HTMLInputElement>("input[data-index]")) {
    if (!checkbox.disabled) checkbox.checked = selectAll.checked;
  }
  refreshToolbar();
});

downloadSelected.addEventListener("click", () => {
  if (!current) return;
  const indexes = selectedIndexes();
  if (!indexes.length) return;
  const url = `/api/public/image-jobs/${encodeURIComponent(current.jobId)}/download.zip?indexes=${indexes.join(",")}`;
  triggerDownload(url);
});

const initial = jobIdFromLocation();
if (initial) {
  jobInput.value = initial;
  void lookup(initial, false);
}

async function lookup(jobId: string, pushUrl: boolean): Promise<void> {
  showStatus("查询中…", false);
  resultEl.hidden = true;
  current = undefined;
  refreshToolbar();

  try {
    const response = await fetch(`/api/public/image-jobs/${encodeURIComponent(jobId)}`);
    if (response.status === 404) {
      showStatus("未找到该任务，可能已过期或不存在。", true);
      return;
    }
    if (response.status === 400) {
      showStatus("Job ID 格式无效。", true);
      return;
    }
    if (response.status === 429) {
      showStatus("查询过于频繁，请稍后再试。", true);
      return;
    }
    if (!response.ok) {
      showStatus("查询失败，请稍后重试。", true);
      return;
    }

    const data = await response.json() as PublicImageJobView;
    current = data;
    renderJob(data);
    statusEl.hidden = true;
    resultEl.hidden = false;
    if (pushUrl) {
      const next = `/jobs/${encodeURIComponent(data.jobId)}`;
      if (window.location.pathname !== next) {
        window.history.pushState({ jobId: data.jobId }, "", next);
      }
    }
  } catch {
    showStatus("网络异常，无法查询任务。", true);
  }
}

function renderJob(job: PublicImageJobView): void {
  metaModel.textContent = job.model;
  metaStatus.textContent = job.status;
  metaStatus.className = `pill is-${job.status}`;
  metaSpec.textContent = [
    job.resolution,
    job.aspectRatio,
    `${job.progress.succeeded}/${job.progress.total} 成功`,
    job.durationMs !== undefined ? `耗时 ${(job.durationMs / 1000).toFixed(job.durationMs >= 10_000 ? 0 : 1)}s` : undefined,
  ].filter(Boolean).join(" · ");
  metaJob.textContent = job.jobId;

  gallery.replaceChildren();
  for (const item of job.items) {
    gallery.append(buildCard(job.jobId, item));
  }

  selectAll.checked = false;
  selectAll.disabled = !job.items.some((item) => item.status === "ready");
  refreshToolbar();
}

function buildCard(jobId: string, item: PublicJobItem): HTMLElement {
  const card = document.createElement("article");
  card.className = "card";

  const media = document.createElement("div");
  media.className = "card-media";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "card-select";
  checkbox.dataset.index = String(item.index);
  checkbox.disabled = item.status !== "ready";
  checkbox.addEventListener("change", refreshToolbar);
  media.append(checkbox);

  if (item.status === "ready" && item.asset?.url) {
    const image = document.createElement("img");
    image.src = item.asset.url;
    image.alt = `第 ${item.index + 1} 张生成图`;
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    media.append(image);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "placeholder";
    placeholder.textContent = item.status === "pending"
      ? "生成中…"
      : (item.error ?? "生成失败");
    media.append(placeholder);
  }

  const body = document.createElement("div");
  body.className = "card-body";

  const index = document.createElement("div");
  index.className = "card-index";
  index.textContent = `#${item.index + 1}`;

  const prompt = document.createElement("p");
  prompt.className = "prompt";
  prompt.textContent = item.prompt || "（无提示词）";

  body.append(index, prompt);

  const actions = document.createElement("div");
  actions.className = "card-actions";
  const download = document.createElement("button");
  download.type = "button";
  download.className = "btn ghost";
  download.textContent = "下载";
  download.disabled = item.status !== "ready";
  download.addEventListener("click", () => {
    triggerDownload(`/api/public/image-jobs/${encodeURIComponent(jobId)}/assets/${item.index}`);
  });
  actions.append(download);

  card.append(media, body, actions);
  return card;
}

function selectedIndexes(): number[] {
  return [...gallery.querySelectorAll<HTMLInputElement>("input[data-index]:checked")]
    .map((node) => Number(node.dataset.index))
    .filter((value) => Number.isInteger(value));
}

function refreshToolbar(): void {
  const readyCount = gallery.querySelectorAll<HTMLInputElement>("input[data-index]:not(:disabled)").length;
  const selected = selectedIndexes().length;
  downloadSelected.disabled = !current || selected === 0;
  downloadSelected.textContent = selected > 0 ? `下载选中（${selected}）` : "下载选中";
  if (readyCount === 0) {
    selectAll.checked = false;
    return;
  }
  const checkedReady = gallery.querySelectorAll<HTMLInputElement>("input[data-index]:checked:not(:disabled)").length;
  selectAll.checked = checkedReady === readyCount;
}

function showStatus(message: string, isError: boolean): void {
  statusEl.hidden = false;
  statusEl.textContent = message;
  statusEl.classList.toggle("is-error", isError);
}

function jobIdFromLocation(): string | undefined {
  const pathMatch = window.location.pathname.match(/\/jobs\/(wj_job_[0-9a-f-]+)/i);
  if (pathMatch?.[1]) return normalizeJobId(pathMatch[1]);
  const query = new URLSearchParams(window.location.search).get("jobId");
  return query ? normalizeJobId(query) : undefined;
}

function normalizeJobId(value: string): string | undefined {
  const trimmed = value.trim();
  if (!/^wj_job_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function triggerDownload(url: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

window.addEventListener("popstate", () => {
  const jobId = jobIdFromLocation();
  if (jobId) {
    jobInput.value = jobId;
    void lookup(jobId, false);
  }
});
