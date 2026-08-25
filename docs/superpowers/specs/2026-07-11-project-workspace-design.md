# Project Workspace（`/project` / `/p`）设计

> 日期: 2026-07-11
> 状态: Draft（待实现计划）
> 参考: fe-ai-flow（task + 任意 action + HITL + artifact）；现有 `/wf` YAML 有序引擎保持不动
>
> ⚠️ 2026-07-13 迭代后与本文档的差异（以代码为准）：
> - HITL 已移除：`project_action_done` 产出即完成（`awaiting_ack` 归一为 `accepted`），完成卡片附全部节点推进按钮
> - 节点改为**流程组**管理（`project-node-groups.json`，默认 develop/test 两组），项目创建时选组（`Project.groupId`）；节点无内置/自定义之分，全部可增删改
> - `ship` 交付节点已拆分为 `deploy`（推送开发分支）与 `submit-test`（MR→测试分支 + 飞书项目评论@测试）；`/p ship` 仅保留 `--set` 分支配置与说明卡
> - ship/MR 目标为 testBranch/developBranch，禁止默认打生产基线 baseBranch

---

## 1. 目标

在 LK Harness 中新增 **项目工作区（Project）**：以飞书为前端，按「一条需求 = 一个隔离工作区」推进 `plan` / `build` / `review` / `ship`，每步产出本地 md artifact，经 HITL 确认后可同步飞书文档；`ship` 使用 GitLab token 推送并开 MR。

**非目标（明确不做）**

- 自有 Web 看板 / 事件流 UI
- 改造或替换现有 `/workflow`（`/wf`）YAML 引擎
- 强制 action 顺序（可跳过 plan，可乱序触发）

---

## 2. 与现有系统的关系

| 能力 | `/wf` | `/project`（本设计） |
|------|-------|----------------------|
| 模型 | 有序节点链 | task + 任意 action 历史 |
| 推进 | `workflow_next` / `reject` | 用户触发 + Agent HITL + `project_action_done` |
| 隔离 | 可选 `isolated` 节点会话 | **git worktree** 每需求一份目录 |
| 指令 | `/wf` | `/project`、别名 `/p` |

二者并行，数据与会话命名空间分离。

---

## 3. 核心概念

### 3.1 Project（一条需求）

- 对应一个 **feature worktree**（共享主仓 `.git`，独立工作目录与分支）
- 拥有专属 Agent 会话：`{chatKey}::project_{id}`，`cwd = worktreePath`
- 维护 `actions[]` 历史（追加式，不删改历史记录；重跑 = 新 action）

### 3.2 Action

v1 类型：`plan` | `build` | `review` | `ship`

状态：`running` | `awaiting_ack` | `accepted` | `rejected` | `failed`

### 3.3 Artifact

- **源真相**：worktree 内本地 markdown
- 路径约定：`{worktreePath}/.lk-harness/artifacts/{actionId}-{type}.md`
- `accepted` 后可同步为 **每 action 一篇飞书文档**，链接写入 action 记录

---

## 4. 数据模型

### 4.1 设置（全局，设置页）

```ts
interface ProjectSettings {
  gitlabToken: string
  gitlabHost?: string          // 默认 https://gitlab.com 或自建
  repoRoots: string[]          // 已 clone 的主仓本地路径（含 .git）
  worktreeRoot: string         // 新建 worktree 的父目录
}
```

凭据只存应用配置，不进 project json、不进 git。

### 4.2 Project 元数据（`APP_DATA/projects/{id}.json`）

```ts
interface Project {
  id: string
  name: string
  goal: string
  storyUrl?: string
  repoPath: string             // 主仓
  baseBranch: string
  featureBranch: string
  worktreePath: string
  status: "active" | "paused" | "done"
  actions: ProjectAction[]
  sessionKey?: string
  createdAt: number
  updatedAt: number
}

interface ProjectAction {
  id: string
  type: "plan" | "build" | "review" | "ship"
  status: "running" | "awaiting_ack" | "accepted" | "rejected" | "failed"
  artifactPath?: string        // 相对 worktree 或绝对，实现时统一
  feishuDocUrl?: string
  summary?: string
  mrUrl?: string               // ship 成功时
  error?: string
  startedAt: number
  completedAt?: number
}
```

另存「当前项目」指针（按主用户 / chat，实现时与现有 session 路由风格对齐）：`APP_DATA/projects/current.json` 或等价结构。

---

## 5. 指令（控制面）

控制面消息打在用户当前 p2p/群聊；干活在专属 `project_*` 会话。

| 指令 | 行为 |
|------|------|
| `/p` / `/project` | 当前项目状态卡（进度、最近产物、本地路径、飞书链接、MR、下一步按钮） |
| `/p new` | 交互收集：主仓、目标、story、基线分支、分支名 → `fetch` + `worktree add` |
| `/p ls` | 列表 |
| `/p use <n\|id>` | 切换当前项目 |
| `/p status` | 状态摘要 |
| `/p plan` / `build` / `review` / `ship` | 对当前项目触发对应 action |
| `/p sync` | 将最近 accepted（或指定）artifact 同步飞书（若自动同步失败可手补） |

v1 **仅主用户**可执行写操作（new / use / action / sync）；只读 ls/status 可同主用户（实现阶段若需放开再议）。

微信侧：指令按钮按现有降级为可发送指令列表。

---

## 6. Worktree 生命周期

**创建（`/p new`）**

1. 校验设置：`gitlabToken`（fetch 私有仓需要时）、`worktreeRoot`、所选 `repoPath` 为合法 git 主仓
2. `git -C repoPath fetch`
3. `git -C repoPath worktree add -b {featureBranch} {worktreePath} {baseBranch的远端或本地跟踪}`
4. 写入 Project 元数据；设为当前项目
5. 失败则不落半残记录（若已 add worktree 则 `worktree remove` 回滚）

**删除 / 完成（可二期命令，v1 可用 status=done + 保留目录）**

- v1 不强制 `worktree remove`；文档注明手动清理方式即可
- 后续可加 `/p close`：标记 done + 可选 remove

---

## 7. Action 运行时（轻编排 + Agent HITL）

### 7.1 触发

1. 控制面校验：存在当前 project；该 project 无 `running` / `awaiting_ack` action（互斥）
2. 追加 action 记录 → `running`
3. 确保专属会话已启动（`cwd=worktreePath`，sessionKey=`{chatKey}::project_{id}`）
4. 向该会话注入 action prompt（含 goal、story、artifact 路径约定、上一份 accepted artifact 路径）

### 7.2 Agent 时序

1. 执行工作并写入 artifact md（`ship` 另含 git push + 开 MR，结果写入摘要）
2. 调用 MCP `project_action_done` → `awaiting_ack`（登记路径 / summary / 可选 mrUrl）
3. `send_question`：通过 / 再聊聊 / 驳回
4. 用户选项进入 **专属会话** 队列；Agent 收结果后再次 `project_action_done` → `accepted` | `rejected`
5. 「再聊聊」：保持 `awaiting_ack`，继续改产物后重复 1–4；禁止并行新 action

### 7.3 飞书同步

- 触发点：action 变为 `accepted` 后自动尝试；失败不阻断 accepted，状态卡提示可 `/p sync`
- 粒度：每 action 一篇飞书文档；URL 写入 `feishuDocUrl`
- 实现优先复用本机 `lark-cli` / 现有飞书发送能力，具体 API 在实现计划中定

### 7.4 ship

- 使用 `ProjectSettings.gitlabToken` + `gitlabHost`
- push `featureBranch` → 对 `baseBranch` 创建 MR
- 成功：`mrUrl`；失败：action `failed` + `error`，控制面通知

### 7.5 失败与重跑

- 会话异常 / 超时：action → `failed`，通知控制面用户
- 重跑：再次 `/p <type>`，新增 action 记录，保留历史

---

## 8. MCP 工具（Daemon）

| 工具 | 用途 |
|------|------|
| `project_action_done` | Agent 登记 action 状态与产物 |
| `project_get` | 查询当前/指定 project（含 actions） |
| `project_list` | 可选，列表 |

控制面指令走现有 command-handler，不强制经 MCP。

---

## 9. UI

**飞书状态卡**：无事件流；展示名称、分支、worktree、最近 action、artifact 本地路径、飞书文档链接、MR 链接；按钮触发 `/p ...`。

**设置页**：GitLab token/host、主仓路径列表、worktree 根目录。

**Dashboard**：v1 可不做独立项目面板；设置项足够。

---

## 10. 架构要点

```
用户聊天 (控制面)
  └─ /p 命令 → command-handler → project-store / worktree / session-dispatcher
项目专属会话 (执行面)
  └─ Agent ← action prompt
       ├─ 写本地 md / git / GitLab MR
       ├─ send_question (HITL)
       └─ project_action_done (MCP) → project-store → 可选飞书文档同步
```

模块建议（实现时可拆）：`project-store`、`project-worktree`、`project-commands`、`project-mcp`、设置 schema 扩展。

---

## 11. 测试要点

- project store CRUD 与当前项目指针
- worktree 创建失败回滚（无残留 json / 无残留 worktree）
- action 状态流转与并发互斥（running / awaiting_ack）
- 指令解析与主用户权限
- ship：MR URL 写入（可用 mock GitLab）
- 飞书同步失败不破坏 accepted

---

## 12. 实现顺序建议

1. 设置 schema + 设置页 UI
2. project-store + 单测
3. worktree 创建/回滚
4. `/p` 指令与状态卡
5. 专属会话拉起 + action prompt 注入
6. MCP `project_action_done` + HITL 约定
7. 飞书 artifact 同步
8. ship / MR
9. changelog + 文档

---

## 13. 决策记录

| 决策 | 选择 |
|------|------|
| 与 `/wf` | 并行新建，不改造引擎 |
| 命名 | `/project`，别名 `/p` |
| 隔离 | git worktree（非完整 clone） |
| Artifact | 本地 md 为源；accepted 后同步飞书（每 action 一篇） |
| 会话 | 每 project 专属会话 |
| 编排 | 轻编排 + Agent HITL（非强引擎） |
| 首版含 | plan/build/review + ship/MR + 飞书同步 |
| 首版不含 | 事件流、自有画布、动 `/wf` |
