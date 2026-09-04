Tasks
  1. [done] #3 没反应：回合失败不再打死长连接 worker + 失败可见（错误回执 + 无条件收口卡片）
  2. [done] #2 500：resolveCustomModelApi 显式协议优先；normalizeGatewayRoot 剥 /responses /messages；删 normalizeCustomBaseUrl 空转层
  3. [done] #1 换模：resolveLlmModelRef / refreshLlmModel 统一走 resolveModelRef（override/pending 优先）
  4. [done] 附带：electron/main.ts 两个既有 TS2739（adhocSdkResource）
  5. [done] 验证：electron tsc 全清 / root tsc 全清 / vitest 23 files 194 tests（+5 新用例）
  6. [ ] 待用户 rebuild 生效：npm run dev（out/main/index.js 仍是 15:51，未含 #2/#3）
