import { describe, expect, it } from "vitest";

import {
  createPersistedCompletedState,
  createPersistedInProgressState,
  planAfterStatus,
  resolveRestorePlan,
} from "../ui/image-result-lifecycle.js";
import {
  getImageJobIdKey,
  getImageResult,
  getImageResultKey,
  imageResultMatchesBinding,
  isTerminalImageJobToolFailure,
} from "../ui/image-result-state.js";

const imageResult = {
  jobId: "wj_job_recoverable",
  model: "gpt-image-2",
  resolution: "2K",
  aspectRatio: "1:1",
  assets: [{ url: "https://img.downk.cc/generated.png", mime_type: "image/png" }],
};

describe("image result state", () => {
  it("reads a direct tool output", () => {
    expect(getImageResult(imageResult)).toEqual(imageResult);
  });

  it("restores a persisted completed widget result", () => {
    expect(getImageResult(createPersistedCompletedState(imageResult, "wj_job_recoverable"))).toEqual(imageResult);
  });

  it("reads the standard tool-result envelope", () => {
    expect(getImageResult({ structuredContent: imageResult })).toEqual(imageResult);
  });

  it("reads ChatGPT full response metadata fallbacks", () => {
    expect(getImageResult({
      mcp_tool_result: {
        structuredContent: imageResult,
      },
    })).toEqual(imageResult);
  });

  it("keeps a widget bound to one job during concurrent tool calls", () => {
    const first = { ...imageResult, jobId: "wj_job_first" };
    const second = { ...imageResult, jobId: "wj_job_second" };
    const bindingKey = getImageJobIdKey("wj_job_first");

    expect(getImageResultKey(first).startsWith(bindingKey)).toBe(true);
    expect(imageResultMatchesBinding(bindingKey, first)).toBe(true);
    expect(imageResultMatchesBinding(bindingKey, second)).toBe(false);
  });

  it("rejects incomplete persisted data", () => {
    expect(getImageResult({ privateContent: { version: 3, phase: "completed" } })).toBeUndefined();
  });

  it("detects expired job poll failures as terminal", () => {
    expect(isTerminalImageJobToolFailure({
      isError: true,
      content: [{
        type: "text",
        text: "WJ image job was not found, has expired, or belongs to another user.",
      }],
    })).toMatch(/过期/);
    expect(isTerminalImageJobToolFailure({
      structuredContent: { jobId: "x", status: "running", model: "WJ", assets: [] },
    })).toBeUndefined();
  });
});

describe("image result lifecycle", () => {
  it("restores completed snapshots without probing status", () => {
    expect(resolveRestorePlan(createPersistedCompletedState(imageResult, "wj_job_recoverable"))).toEqual({
      kind: "render",
      imageResult,
    });
  });

  it("probes by jobId when completed phase has no asset snapshot", () => {
    expect(resolveRestorePlan({
      privateContent: { version: 3, phase: "completed", jobId: "wj_job_recoverable" },
    })).toEqual({
      kind: "probe_status",
      jobId: "wj_job_recoverable",
    });
  });

  it("probes status once for in-progress jobs", () => {
    expect(resolveRestorePlan(createPersistedInProgressState("job_abc"))).toEqual({
      kind: "probe_status",
      jobId: "job_abc",
    });
  });

  it("maps a completed status snapshot to render", () => {
    expect(planAfterStatus({
      jobId: "job_abc",
      status: "completed",
      model: "gpt-image-2",
      assets: imageResult.assets,
    })).toEqual({
      kind: "render",
      imageResult: {
        jobId: "job_abc",
        model: "gpt-image-2",
        assets: imageResult.assets,
        failureCount: 0,
      },
    });
  });

  it("keeps probing while status remains in progress", () => {
    expect(planAfterStatus({
      jobId: "job_abc",
      status: "running",
      model: "gpt-image-2",
      assets: [],
    })).toEqual({
      kind: "probe_status",
      jobId: "job_abc",
    });
  });

  it("keeps probing when progressive assets arrive before completion", () => {
    expect(planAfterStatus({
      jobId: "job_abc",
      status: "running",
      model: "gpt-image-2",
      assets: imageResult.assets,
      progress: { total: 2, succeeded: 1, failed: 0, pending: 1 },
    })).toEqual({
      kind: "probe_status",
      jobId: "job_abc",
    });
  });
});
