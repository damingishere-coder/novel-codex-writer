import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { novelLibraryPlugin } from "./server/novel-library-plugin.ts";

const MAX_JS_CHUNK_BYTES = 500 * 1024;
const MAX_TOTAL_JS_BYTES = 1024 * 1024;
const MAX_TOTAL_CSS_BYTES = 100 * 1024;

function bundleBudgetPlugin(): Plugin {
  return {
    name: "bundle-budget",
    apply: "build",
    generateBundle(_options, bundle) {
      let totalJavaScript = 0;
      let totalCss = 0;
      const violations: string[] = [];
      for (const [fileName, output] of Object.entries(bundle)) {
        const bytes = output.type === "chunk"
          ? Buffer.byteLength(output.code)
          : typeof output.source === "string"
            ? Buffer.byteLength(output.source)
            : output.source.byteLength;
        if (fileName.endsWith(".js")) {
          totalJavaScript += bytes;
          if (bytes > MAX_JS_CHUNK_BYTES) {
            violations.push(`${fileName} 为 ${(bytes / 1024).toFixed(1)} KiB，超过单包 500 KiB 上限`);
          }
        }
        if (fileName.endsWith(".css")) totalCss += bytes;
      }
      if (totalJavaScript > MAX_TOTAL_JS_BYTES) {
        violations.push(`JavaScript 总量为 ${(totalJavaScript / 1024).toFixed(1)} KiB，超过 1 MiB 上限`);
      }
      if (totalCss > MAX_TOTAL_CSS_BYTES) {
        violations.push(`CSS 总量为 ${(totalCss / 1024).toFixed(1)} KiB，超过 100 KiB 上限`);
      }
      if (violations.length) this.error(`构建产物超过性能预算：\n- ${violations.join("\n- ")}`);
    }
  };
}

export default defineConfig({
  plugins: [novelLibraryPlugin(), react(), bundleBudgetPlugin()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("@codemirror/lang-markdown") || id.includes("@lezer/markdown")) return "codemirror-markdown";
          if (id.includes("@codemirror") || id.includes("@lezer")) return "codemirror-core";
          return undefined;
        }
      }
    }
  }
});
