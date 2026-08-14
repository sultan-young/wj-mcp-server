import { describe, expect, it } from "vitest";

import { ImageJobStore } from "../src/image-job-store.js";
import { memoryRedis } from "./helpers.js";

describe("ImageJobStore progressive append", () => {
  it("keeps every concurrent prompt outcome without dropping assets", async () => {
    const store = new ImageJobStore(memoryRedis(), 1_200, 2_592_000);
    const record = await store.create({
      subject: "subject",
      terminalId: "terminal",
      input: {
        prompts: ["one", "two", "three"],
        model: "gpt-image-2",
        aspect_ratio: "1:1",
        resolution: "2K",
      },
    });
    await store.markRunning(record.jobId);

    await Promise.all([
      store.appendPromptOutcome(record.jobId, {
        index: 0,
        asset: {
          type: "image",
          mime_type: "image/png",
          url: "https://img.downk.cc/one.png",
          prompt_index: 0,
        },
      }),
      store.appendPromptOutcome(record.jobId, {
        index: 1,
        asset: {
          type: "image",
          mime_type: "image/png",
          url: "https://img.downk.cc/two.png",
          prompt_index: 1,
        },
      }),
      store.appendPromptOutcome(record.jobId, {
        index: 2,
        failure: { index: 2, error: "upstream failed" },
      }),
    ]);

    const recordAfter = await store.get("subject", record.jobId);
    expect(recordAfter).toBeTruthy();
    const view = store.toView(recordAfter!);
    expect(view.assets.map((asset) => asset.url)).toEqual([
      "https://img.downk.cc/one.png",
      "https://img.downk.cc/two.png",
    ]);
    expect(view.failures).toEqual([{ index: 2, error: "upstream failed" }]);
    expect(view.progress).toEqual({
      total: 3,
      succeeded: 2,
      failed: 1,
      pending: 0,
    });
  });
});
