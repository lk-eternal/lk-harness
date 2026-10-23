import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// 手机端据此判断「我是哪一版」，与电脑端查到的最新发布版比较
const appVersion = (JSON.parse(readFileSync(resolve("package.json"), "utf-8")) as { version: string }).version

export default defineConfig({
  root: "src/mobile",
  base: "./",
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  build: {
    outDir: resolve("out/mobile"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      input: resolve("src/mobile/index.html"),
    },
  },
})
