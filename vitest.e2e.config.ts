import { defineConfig } from "vitest/config"

/**
 * 端到端测试：会起真实的 daemon 进程，单独跑（`npm run test:e2e`），不在默认的 `npm test` 里。
 */
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    include: ["tests/e2e/**/*.e2e.test.ts"],
    environment: "node",
    // 每个用例都要起一个 daemon（tsx 冷启动），留足时间
    testTimeout: 60000,
    hookTimeout: 60000,
    // 每个文件各起各的 daemon，串行跑避免抢 CPU 导致启动超时
    fileParallelism: false,
  },
})
