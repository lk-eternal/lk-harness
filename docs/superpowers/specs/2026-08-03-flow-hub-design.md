# 流程组共享 Hub 设计

> 日期: 2026-08-03  
> 状态: Approved（2026-08-03）  
> 关联: 设置页「项目 → 流程组」、`project-node-groups.json`、现有导入/导出 envelope

---

## 1. 目标

在 LK Harness 设置页的**流程组**模块，接入团队 GitLab 共享仓库（Flow Hub），实现：

- **上传**：本地流程组 / 独立节点 → 直推 Hub `main` 分支
- **获取**：搜索 / 浏览 Hub → 添加到本地（整组或单节点）
- **同步**：通过 `hubId` 识别已添加项；Hub 与本地内容不一致时提示同步
- **作者展示**：上传时携带用户昵称，浏览/搜索时显示作者

**已确认决策**

| 项 | 决策 |
|---|---|
| 写入方式 | 直推 `main`（不走 MR） |
| 独立节点 | 第一期就要 |
| 认证 | 复用设置页已有 `gitlabToken` + `gitlabHost` |
| 作者 | 设置页新增「Hub 作者昵称」输入框 |

**非目标（第一期不做）**

- MR 审核流、版本回滚 UI
- 非 GitLab 后端（S3 / 自建 API）
- Hub 内节点/组的权限分级（全员可读写）

---

## 2. 与现有系统的关系

| 现有能力 | Hub 扩展 |
|---|---|
| 本地 JSON 导出/导入（`kind: lk-harness-node-group`） | envelope 加 `hubId` / `hubRevision` / `author`，格式向后兼容 |
| `project-node-groups.json` 持久化 | 组/节点增加 Hub 追踪字段（见 §4） |
| `resolveUniqueNodeGroupId` / slug `id` | **不变**：`/p` 命令仍用 slug；`hubId` 仅用于共享识别 |
| `getDefaultNodeGuide` | 不变；Hub 只传用户自定义 prompt |

---

## 3. 方案对比（Brainstorming）

### 方案 A：GitLab 仓库 + catalog 索引（推荐）

Hub = Git 仓库，每次上传 commit 更新 `catalog.json` + 实体 JSON 文件。

| 优点 | 缺点 |
|---|---|
| 用户已建好仓库；与现有 GitLab Token 自然复用 | 并发上传 catalog 冲突（小团队可接受，失败重试） |
| 可读 raw / API，无需 clone | 需解析「仓库 URL → projectId」 |
| 历史可追溯（git log） | catalog 需在上传时原子更新 |

### 方案 B：GitLab Package / Generic Package Registry

把 JSON 当 package 版本发布。

| 优点 | 缺点 |
|---|---|
| 自带版本号 | API 生疏；browse 体验差 |
| | 与「目录浏览」心智不符 |

### 方案 C：仅 HTTP 静态站（GitLab Pages）

| 优点 | 缺点 |
|---|---|
| 读取极快 | 写入仍需 CI 或 API，不比 A 简单 |

**推荐方案 A**：与现有导出格式一致，实现路径最短，读取侧可缓存 catalog。

---

## 4. 数据模型

### 4.1 Hub 仓库目录结构

```
cursor-claw-flow-hub/          # 仓库根（main 分支）
├── catalog.json               # 索引：搜索 / 分页 / 作者 / 更新时间
├── groups/
│   └── {hubId}.json           # 流程组 envelope
└── nodes/
    └── {hubId}.json           # 独立节点 envelope
```

### 4.2 catalog.json

```ts
interface FlowHubCatalog {
  version: 1
  updatedAt: string             // ISO8601
  groups: FlowHubCatalogGroup[]
  nodes: FlowHubCatalogNode[]
}

interface FlowHubCatalogGroup {
  hubId: string                   // UUID
  name: string
  nodeLabels: string[]            // 节点显示名列表（卡片摘要）
  nodeIds: string[]               // slug id 列表（hover 映射用）
  author: string
  updatedAt: string
  contentHash: string             // sha256，同步检测
}

interface FlowHubCatalogNode {
  hubId: string
  label: string
  localId: string                 // 原 slug id，如 plan / mr
  author: string
  updatedAt: string
  contentHash: string
  sourceGroupName?: string        // 若从组内拆出上传，可选标注来源组名
}
```

**分页策略**：客户端拉取完整 `catalog.json` 后本地过滤 + 虚拟滚动（每批 20 条）。团队规模上百条目内足够；超出后再做 catalog 分片（非第一期）。

### 4.3 组 envelope（`groups/{hubId}.json`）

```ts
interface FlowHubGroupEnvelope {
  kind: "lk-harness-node-group"
  version: 2
  hubId: string
  hubRevision: number
  author: string
  updatedAt: string
  contentHash: string
  group: {
    id: string                    // slug，仅供参考；导入时可 rename
    name: string
    workspace?: "worktree" | "plain"
    nodes: FlowHubNodePayload[]
  }
}

interface FlowHubNodePayload {
  hubId: string                   // 节点级 UUID（组内节点各自独立）
  id: string                      // slug
  label: string
  prompt?: string
}
```

### 4.4 独立节点 envelope（`nodes/{hubId}.json`）

```ts
interface FlowHubNodeEnvelope {
  kind: "lk-harness-flow-node"
  version: 1
  hubId: string
  hubRevision: number
  author: string
  updatedAt: string
  contentHash: string
  node: FlowHubNodePayload
}
```

### 4.5 本地持久化扩展

**设置（全局 config，与 gitlabToken 同级）**

```ts
interface FlowHubSettings {
  flowHubUrl?: string             // 如 https://gitlab.wukongedu.net/internal-shared/cursor-claw-flow-hub
  flowHubAuthor?: string          // 上传者昵称
}
```

**流程组文件 `project-node-groups.json`**

```ts
interface ProjectNodeGroupDef {
  id: string
  name: string
  workspace?: ProjectWorkspaceType
  nodes: ProjectNodeDef[]
  // ── Hub 追踪（可选，未上传则无） ──
  hubId?: string
  hubRevision?: number
  hubContentHash?: string
  localRevision?: number          // 本地编辑计数；有本地未同步改动时 > hubRevision 对应状态
}

interface ProjectNodeDef {
  id: string
  label: string
  prompt?: string
  hubId?: string
  hubRevision?: number
  hubContentHash?: string
  localRevision?: number
}
```

**hubId 生成规则**

- 新建组 / 节点时自动生成 `crypto.randomUUID()`
- 存量数据：首次「上传」时补生成；导入 Hub 项时使用 envelope 内 hubId

**contentHash 计算**

对 envelope 内业务字段（group/node 的 name、workspace、nodes 顺序、各节点 label+prompt）做 canonical JSON 后 sha256，不含 hubRevision / updatedAt / author。

---

## 5. GitLab 集成

### 5.1 URL 解析

输入：`https://gitlab.wukongedu.net/internal-shared/cursor-claw-flow-hub`

1. 取 origin → `gitlabHost`（若与设置不一致，Hub 操作时用 URL 内的 host，Token 仍用配置项——需同实例）
2. path → `internal-shared/cursor-claw-flow-hub`
3. `GET /api/v4/projects/{urlencoded_path}` → `projectId`

### 5.2 读取

| 操作 | API |
|---|---|
| 拉 catalog | `GET .../repository/files/catalog.json/raw?ref=main` |
| 拉组/节点 | `GET .../repository/files/groups%2F{hubId}.json/raw?ref=main` |
| 404 | 视为 Hub 未初始化或项已删除 |

### 5.3 写入（直推 main）

单次 commit 可含多个 action（原子更新实体 + catalog）：

```
POST /api/v4/projects/:id/repository/commits
{
  branch: "main",
  commit_message: "flow-hub: upload group {name} by {author}",
  actions: [
    { action: "create|update", file_path: "groups/{hubId}.json", content: base64(...) },
    { action: "update", file_path: "catalog.json", content: base64(...) }
  ]
}
```

**并发冲突**：若 commit 失败（文件已被更新），重新 fetch catalog → merge 条目 → 重试一次；仍失败则提示用户稍后重试。

**Hub 初始化**：catalog 或目录不存在时，首次上传创建 `catalog.json` + 子目录。

### 5.4 认证

复用 `saveConfig` 中的 `gitlabToken` / `gitlabHost`。Hub URL 的 host 必须与 `gitlabHost` 一致（不一致时 UI 警告，禁止上传）。

---

## 6. UI 设计

### 6.1 设置页 · 流程组 Tab 顶部 — 共享空间配置

```
┌─ 共享空间 ──────────────────────────────────────────────┐
│ Hub 地址   [https://gitlab.wukongedu.net/.../flow-hub ] │
│ 作者昵称   [张三                                        ] │
│ （上传时使用已有 GitLab Token；未配置 Token 时上传不可用）│
└─────────────────────────────────────────────────────────┘
```

- Hub 地址 / 作者昵称随设置页自动保存（与 gitlabToken 相同 debounce 逻辑）
- **未填 Hub 地址**：隐藏所有 Hub 按钮（上传、从共享空间获取）

### 6.2 流程组列表行

```
[开发] [测试] ...  [+ 新增组]  [↓ 从共享空间获取组]
```

### 6.3 当前组操作栏

```
当前组 develop · 8 节点  [编辑] [↑ 上传] [导出] [导入] [删除]
```

- **↑ 上传**：整组上传；成功后更新本地 `hubRevision` / `hubContentHash`

### 6.4 节点列表底部

```
[+ 新增节点]
[↓ 从共享空间获取节点]
```

节点编辑弹窗增加 **↑ 上传此节点**（独立节点入库 `nodes/{hubId}.json`）。

### 6.5 浏览弹窗（组 / 节点共用组件 `FlowHubBrowser`）

```
┌ 从共享空间获取流程组 ─────────────────────────────── ✕ ┐
│ 🔍 [搜索组名 / 节点名 / 作者...                    ] │
├──────────────────────────────────────────────────────┤
│ ┌─────────────────────┐  ┌─────────────────────┐    │
│ │ 开发（by 张三）      │  │ 测试（by 李四） ✓已添加│    │
│ │ 规划·实现·MR·提测    │  │ 测试评审·用例·部署    │    │
│ │ 8/3 更新      [+]   │  │ 7/28 更新    [↻同步] │    │
│ └─────────────────────┘  └─────────────────────┘    │
│ ... 无限滚动加载 ...                                   │
└──────────────────────────────────────────────────────┘
```

**卡片交互**

| 状态 | 右下角按钮 | 行为 |
|---|---|---|
| 未添加 | `[+]` | 导入到本地（组 → 新组；节点 → 当前组末尾） |
| 已添加且一致 | `✓ 已添加` | 不可点 |
| 已添加但 Hub 更新 | `[↻ 同步]` | 见 §7.3 |
| 已添加且本地改过 | `[↻ 同步]` | 先弹 diff，再选覆盖/保留 |

**Hover 节点标签**：Tooltip 展示该节点 prompt 前 300 字（组卡片）；节点卡片 hover 展示完整 prompt。

**搜索**：对 `name / nodeLabels / author / localId` 做客户端 substring 过滤；空搜索 = 展示全部（catalog 顺序：updatedAt 降序）。

---

## 7. 核心流程

### 7.1 上传流程组

1. 校验：Hub 地址、GitLab Token、作者昵称非空
2. 组内每个节点若无 `hubId` → 生成
3. 组若无 `hubId` → 生成
4. 计算 `contentHash`，`hubRevision` = (本地 hubRevision ?? 0) + 1
5. 构建 envelope，commit 到 `groups/{hubId}.json`
6. 更新 catalog 对应条目，`localRevision` 清零，`hubContentHash` 对齐
7. 保存本地 `project-node-groups.json`

### 7.2 上传独立节点

同上，路径 `nodes/{hubId}.json`；catalog.nodes 追加/更新。

若节点已属于某已上传组：**允许**独立再上传（catalog 中同时存在）；导入时按 hubId 去重。

### 7.3 导入 / 同步

**导入新组**

1. 下载 envelope → `parseNodeGroupExport` 扩展解析
2. 若本地已有同 `hubId` → 走同步流程
3. 否则：`resolveUniqueNodeGroupId` 处理 slug 冲突 → append 到 groups

**导入新节点到当前组**

1. 下载 node envelope
2. 若当前组已有同 hubId 节点 → 同步
3. 否则：slug 冲突则 `{id}-2` → append

**同步（Hub 更新）**

1. 比较 `contentHash`：相同 → 无操作
2. 本地 `localRevision > 0` 且 hash 不同 → **Diff 弹窗**：
   - 「用 Hub 覆盖本地」
   - 「保留本地」（仅更新 hubRevision 标记？**否**——保留本地则不上调 hubRevision，继续显示可同步）
   - 「取消」
3. 本地无未同步改动 → 一键覆盖，更新 hash / revision

### 7.4 Diff 弹窗（节点级粒度）

组同步：逐节点列出变更（label / prompt 变）；用户可勾选要同步的节点或整组覆盖。

---

## 8. 模块划分

```
electron/flow-hub/
  gitlab-api.ts       # projectId 解析、raw 读、commit 写
  catalog.ts          # catalog 读写、merge、search
  envelope.ts         # 构建/解析 envelope、contentHash
  sync.ts             # 导入/同步/diff 逻辑

electron/daemon-manager.ts   # IPC: flow-hub:* 
src/renderer/components/FlowHubBrowser.tsx
src/renderer/pages/Settings.tsx   # 配置区 + 按钮入口
src/shared/project-store.ts       # hubId 字段 sanitize 保留
src/shared/flow-hub-types.ts      # 共享类型
```

**IPC 列表**

| Channel | 说明 |
|---|---|
| `flow-hub:get-catalog` | 拉 catalog（带缓存 TTL 60s） |
| `flow-hub:upload-group` | 上传组 |
| `flow-hub:upload-node` | 上传节点 |
| `flow-hub:import-group` | 导入组 |
| `flow-hub:import-node` | 导入节点到指定 groupId |
| `flow-hub:sync-group` | 同步已添加组 |
| `flow-hub:sync-node` | 同步已添加节点 |
| `flow-hub:preview` | 下载 envelope 供 hover / diff，不写本地 |

---

## 9. 错误处理

| 场景 | 处理 |
|---|---|
| Token 无效 / 403 | Toast：检查 GitLab Token 与仓库权限 |
| Hub 地址 404 | 提示仓库不存在或无权限 |
| catalog 与实体文件不一致 | 以实体文件为准，catalog 下次上传修复 |
| slug 冲突 | 自动 rename，toast 告知新 id |
| 作者昵称为空 | 禁止上传，聚焦输入框 |
| 网络超时 | 重试一次；失败 toast |

---

## 10. 测试计划

**单元测试（vitest）**

- `contentHash` 稳定性（字段顺序无关）
- `parseNodeGroupExport` 兼容 v1 envelope
- catalog merge（新增 / 更新 / 不变）
- slug 冲突 resolve
- 同步判定：hash 相同 / 不同 / localRevision

**集成测试（mock GitLab API）**

- 上传组 → catalog 含条目
- 导入组 → 本地 groups 增加
- 同步覆盖 / diff 保留本地

**手工验证**

- 设置 Hub 地址 + 作者 + Token
- 上传开发组 → 另一实例浏览并导入
- 修改 Hub 上 JSON（模拟他人更新）→ 同步按钮出现
- 本地改 prompt 后同步 → diff 弹窗

---

## 11. 分期交付

| 阶段 | 内容 | 预估 |
|---|---|---|
| **P1** | 类型 + GitLab API + catalog 读取 + 浏览弹窗 + 导入组/节点 | 2d |
| **P2** | 上传组/节点 + catalog 写入 + 作者 | 1d |
| **P3** | 已添加/可同步状态 + diff 同步 + hover prompt | 1.5d |
| **P4** | 测试 + 边界（并发重试、Hub 初始化） | 0.5d |

用户要求第一期含独立节点 → P1 即覆盖组+节点导入，P2 覆盖上传。

---

## 12. 开放问题（评审时可确认）

1. **Hub 仓库写权限**：是否全员 Maintainer？若仅部分人有写权限，他人只读获取——当前设计已支持。
2. **删除**：第一期不支持从 Hub 删除（避免误删）；后续可加「上传者本人可删」。
3. **组内节点上传后又在组里删除**：Hub 上独立节点仍在 catalog.nodes——符合预期。

---

## 13. 评审检查清单

- [ ] envelope 格式与现有导入兼容
- [ ] slug / hubId 双轨清晰
- [ ] Token 复用、作者昵称字段
- [ ] 直推 main + catalog 并发策略可接受
- [ ] UI 入口位置与交互
- [ ] 第一期范围（含独立节点上传/获取）

---

*评审通过后 → 调用 writing-plans 产出实现计划。*
