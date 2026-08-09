import {defineConfig} from "vite";
import vue from "@vitejs/plugin-vue";
import {resolve} from "node:path";

export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: "field_ops_demo/public/frontend",
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(import.meta.dirname, "frontend/main.js"),
      output: {
        entryFileNames: "field-ops.js",
        assetFileNames: (asset) => asset.names?.some((name) => name.endsWith(".css"))
          ? "field-ops.css" : "[name]-[hash][extname]",
      },
    },
  },
});
