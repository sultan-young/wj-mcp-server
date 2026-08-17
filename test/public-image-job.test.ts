import { describe, expect, it, vi } from "vitest";
import request from "supertest";

import { createApplication } from "../src/app.js";
import { ImageJobStore } from "../src/image-job-store.js";
import { toPublicImageJobView } from "../src/public-image-job.js";
import type { RedisClient } from "../src/redis.js";
import { memoryRedis, testConfig, testLogger } from "./helpers.js";

describe("public image job view", () => {
  it("pairs prompts with assets and failures", async () => {
    const store = new ImageJobStore(memoryRedis(), 1_200, 2_592_000);
    const record = await store.create({
      subject: "subject",
      terminalId: "terminal",
      input: {
        prompts: ["alpha", "beta", "gamma"],
        model: "gpt-image-2",
        aspect_ratio: "1:1",
        resolution: "1K",
      },
    });
    await store.markRunning(record.jobId);
    await store.appendPromptOutcome(record.jobId, {
      index: 0,
      asset: {
        type: "image",
        mime_type: "image/png",
        url: "https://img.downk.cc/a.png",
        prompt_index: 0,
      },
    });
    await store.appendPromptOutcome(record.jobId, {
      index: 1,
      failure: { index: 1, error: "boom" },
    });
    await store.complete(record.jobId, {
      assets: [{
        type: "image",
        mime_type: "image/png",
        url: "https://img.downk.cc/a.png",
        prompt_index: 0,
      }],
      failures: [{ index: 1, error: "boom" }, { index: 2, error: "missing" }],
      model: "gpt-image-2",
      resolution: "1K",
      aspectRatio: "1:1",
    });

    const latest = await store.getByJobId(record.jobId);
    expect(latest).toBeTruthy();
    const view = toPublicImageJobView(latest!);
    expect(view.items).toEqual([
      expect.objectContaining({ index: 0, prompt: "alpha", status: "ready" }),
      expect.objectContaining({ index: 1, prompt: "beta", status: "failed", error: "boom" }),
      expect.objectContaining({ index: 2, prompt: "gamma", status: "failed" }),
    ]);
    expect(view.meta.referenceImageUrls).toEqual([]);
    expect(view).not.toHaveProperty("subject");
  });

  it("exposes shared reference image URLs under meta", async () => {
    const store = new ImageJobStore(memoryRedis(), 1_200, 2_592_000);
    const record = await store.create({
      subject: "subject",
      terminalId: "terminal",
      input: {
        prompts: ["edit this"],
        model: "gpt-image-2",
        aspect_ratio: "1:1",
        resolution: "1K",
        gpt_reference_images: [
          {
            download_url: "https://files.example.com/ref-a.png",
            file_id: "file_a",
            mime_type: "image/png",
          },
          {
            download_url: "https://files.example.com/ref-b.png",
            file_id: "file_b",
          },
          {
            download_url: "https://files.example.com/ref-a.png",
            file_id: "file_a_dup",
          },
        ],
      },
    });

    const view = toPublicImageJobView(record);
    expect(view.meta.referenceImageUrls).toEqual([
      "https://files.example.com/ref-a.png",
      "https://files.example.com/ref-b.png",
    ]);
  });
});

describe("public image job HTTP", () => {
  it("serves the viewer page and job JSON without auth", async () => {
    const redis = memoryRedis();
    const store = new ImageJobStore(redis, 1_200, 2_592_000);
    const record = await store.create({
      subject: "subject",
      terminalId: "terminal",
      input: {
        prompts: ["a quiet cabin"],
        model: "gpt-image-2",
        aspect_ratio: "1:1",
        resolution: "1K",
      },
    });
    await store.complete(record.jobId, {
      assets: [{
        type: "image",
        mime_type: "image/png",
        url: "https://img.downk.cc/cabin.png",
        width: 1024,
        height: 1024,
        prompt_index: 0,
      }],
      failures: [],
      model: "gpt-image-2",
      resolution: "1K",
      aspectRatio: "1:1",
      durationMs: 12_000,
    });

    const fetchImpl = vi.fn(async () => new Response(Buffer.from("png-bytes"), {
      status: 200,
      headers: { "content-type": "image/png" },
    }));

    const app = await createApplication({
      config: testConfig(),
      logger: testLogger(),
      redis: {
        ...redis,
        ping: async () => "PONG",
        on: vi.fn(),
      } as unknown as RedisClient,
      widgetHtml: "<!doctype html><p>widget</p>",
      jobViewerHtml: "<!doctype html><title>jobs</title>",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const page = await request(app).get(`/jobs/${record.jobId}`).expect(200);
    expect(page.text).toContain("jobs");
    expect(page.headers["content-type"]).toContain("text/html");

    const json = await request(app)
      .get(`/api/public/image-jobs/${record.jobId}`)
      .expect(200);
    expect(json.body).toEqual(expect.objectContaining({
      jobId: record.jobId,
      model: "gpt-image-2",
      items: [expect.objectContaining({
        index: 0,
        prompt: "a quiet cabin",
        status: "ready",
        asset: expect.objectContaining({ url: "https://img.downk.cc/cabin.png" }),
      })],
    }));

    const file = await request(app)
      .get(`/api/public/image-jobs/${record.jobId}/assets/0`)
      .expect(200);
    expect(file.headers["content-disposition"]).toContain("attachment");
    expect(file.body.toString()).toBe("png-bytes");

    const zip = await request(app)
      .get(`/api/public/image-jobs/${record.jobId}/download.zip?indexes=0`)
      .buffer()
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(zip.headers["content-type"]).toContain("application/zip");
    expect(Buffer.isBuffer(zip.body)).toBe(true);
    expect((zip.body as Buffer).length).toBeGreaterThan(20);
  });
});
