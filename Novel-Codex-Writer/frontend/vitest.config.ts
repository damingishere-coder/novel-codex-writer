import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      exclude: [...configDefaults.exclude, "e2e/**"],
      coverage: {
        provider: "v8",
        reportsDirectory: "coverage",
        reporter: ["text", "json-summary", "html", "lcov"],
        include: ["src/**/*.{ts,tsx}", "server/**/*.ts", "shared/**/*.ts"],
        exclude: ["**/*.test.ts", "**/*.test.tsx", "src/main.tsx"],
        thresholds: {
          statements: 41,
          branches: 36,
          functions: 35,
          lines: 44
        }
      }
    }
  })
);
