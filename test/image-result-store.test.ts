import { describe, expect, it, vi } from "vitest";

import { ImageResultStore } from "../src/image-result-store.js";
import type { RedisClient } from "../src/redis.js";

describe("ImageResultStore", () => {
  it("stores image results for 30 days and enforces subject ownership", async () => {
    const records = new Map<string, string>();
    const set = vi.fn(async (key: string, value: string) => {
      records.set(key, value);
      return "OK";
    });
    const get = vi.fn(async (key: string) => records.get(key) ?? null);
    const store = new ImageResultStore({ set, get } as unknown as RedisClient, 2_592_000);

    const saved = await store.save("user-a", {
      model: "gpt-image-2",
      resolution: "2K",
      aspectRatio: "1:1",
      assets: [{ type: "image", mime_type: "image/png", url: "https://img.downk.cc/result.png" }],
    });

    expect(saved.resultId).toMatch(/^wj_img_/);
    expect(Date.parse(saved.expiresAt) - Date.parse(saved.createdAt)).toBe(2_592_000_000);
    expect(set).toHaveBeenCalledWith(
      `wj:mcp:image-result:${saved.resultId}`,
      expect.any(String),
      { EX: 2_592_000 },
    );
    await expect(store.get("user-a", saved.resultId)).resolves.toEqual(saved);
    await expect(store.get("user-b", saved.resultId)).resolves.toBeUndefined();
  });
});
