import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const uiRoot = fileURLToPath(new URL("./ui", import.meta.url));

export default defineConfig({
  root: uiRoot,
  plugins: [viteSingleFile()],
  build: {
    outDir: "../dist/ui",
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(uiRoot, "job-viewer.html"),
    },
  },
});
