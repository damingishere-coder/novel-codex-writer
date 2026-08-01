import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { novelLibraryPlugin } from "./server/novel-library-plugin";

export default defineConfig({
  plugins: [novelLibraryPlugin(), react()],
  server: {
    host: "127.0.0.1",
    port: 5173
  },
  preview: {
    host: "127.0.0.1",
    port: 4173
  }
});
