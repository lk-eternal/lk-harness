/**
 * 测试进程的环境隔离（vitest.config.ts / vitest.e2e.config.ts 的 setupFiles）。
 *
 * 从 LK Harness 里起的 Agent 会继承应用的环境变量，其中 APP_DATA_DIR 指向真实的用户数据目录。
 * 一部分代码（agent-sdk 的会话存储、file-queue、session-overrides-store 等）优先读它、
 * 其次才是测试里 mock 的 electron.app.getPath，于是单元测试建的会话目录全写进了真实目录：
 * 每跑一次测试多一批 `ch_t12|oc_chat12::…\Temp\lk-sdk-launch-…` 之类的残留，
 * 残留多了以后每次刷新会话列表都要把它们逐个扫一遍。
 *
 * 这里在每个测试进程里先把它清掉，和 CI / 没有从应用里起的终端是同一个环境；
 * 需要它的测试自己设（并在结束时还原），端到端用例给子进程的值由 helpers/isolated-daemon 显式传入。
 */
delete process.env.APP_DATA_DIR
