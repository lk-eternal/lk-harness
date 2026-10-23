import { defineConfig } from "vitest/config"

export default defineConfig({
  // 与 tsconfig.renderer.json 的 jsx: react-jsx 一致，渲染层组件才能在测试里直接渲染
  esbuild: { jsx: "automatic" },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
  },
})
