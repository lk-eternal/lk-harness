import { resolve } from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  root: "src/mobile",
  base: "./",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve("out/mobile"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      input: resolve("src/mobile/index.html"),
    },
  },
})
