import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { APP_VERSION } from "../src/version.js";

describe("application version", () => {
  it("keeps the package and MCP server versions in sync", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    expect(APP_VERSION).toBe("0.1.7");
    expect(packageJson.version).toBe(APP_VERSION);
  });
});
