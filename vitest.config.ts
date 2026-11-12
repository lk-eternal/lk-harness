import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  // 与 tsconfig.renderer.json 的 jsx: react-jsx 一致，渲染层组件才能在测试里直接渲染
  esbuild: { jsx: "automatic" },
  test: {
    include: ["tests/**/*.test.ts"],
    // 端到端测试要起真实 daemon，走 `npm run test:e2e`（vitest.e2e.config.ts）
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
    environment: "node",
    testTimeout: 30000,
    // 去掉从应用里继承来的 APP_DATA_DIR：否则测试会把会话目录写进真实用户数据目录
    setupFiles: ["tests/setup/isolate-env.ts"],
  },
})
