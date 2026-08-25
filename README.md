# LK Harness

把 Cursor 变成 7×24 小时在线的数字雇员 —— 在飞书 / 微信里随时随地指挥 AI 干活。

Cursor Agent 的交互被锁死在本地 IDE 里，人一离开电脑，协作就停了。**LK Harness** 把整条交互搬到你的手机上：AI 干活时实时看到它的思考与操作，AI 有问题时手机上点个按钮就能拍板，会话断了自动重连接着干。

## 效果展示

| 流式进度卡：实时看 AI 思考与工具调用 | 提问卡片：手机上点按钮拍板 |
|---|---|
| <img src="docs/screenshots/stream-card.png" width="360" /> | <img src="docs/screenshots/question-card.png" width="360" /> |

| 状态卡片：随时掌握运行状态 | 项目菜单：节点按钮推进研发流程 |
|---|---|
| <img src="docs/screenshots/status-card.png" width="360" /> | <img src="docs/screenshots/project-menu.png" width="360" /> |

Dashboard：通道 / 会话 / 分支 / 模型与实时日志一目了然

<img src="docs/screenshots/dashboard.png" width="760" />

## 它能做什么

### 随时随地与 AI 协作

- 给飞书机器人或微信发消息，AI 在你配置的工作目录里干活，结果直接回到手机
- AI 需要决策时发**选项卡片**，点按钮即回复；也可以直接打字插话
- 发图片、发文件双向都支持：截图给 AI 看，AI 把产物文件发回给你
- 消息「至少一次投递」：AI 掉线、应用重启，没处理完的消息都会重投，不静默丢失

### 流式进度卡

基于 Cursor Agent SDK 直跑 + 飞书 CardKit 流式卡片：

- AI 的**思考过程、每一次工具调用**按时间线实时刷新在一张卡片里
- 回复自动并入卡片正文，长对话超出卡片容量时自动收敛（越新的内容精度越高）
- 不想看思考过程可以按通道一键关闭

### 项目工作区

把「一个需求」封装成独立协作单元：**一个项目 = 一个 git worktree（可多仓）+ 一条 feature 分支 + 一个专属会话**。

- `/p new` 走飞书表单建项，自动隔离检出，与主仓互不干扰
- 点节点按钮推进流程：规划 → 实现 → 审查 → 部署 → 提测…（节点组可自定义，内置「开发」「测试」两组）
- 可自动创建**项目专属飞书群**，群内消息强制路由到本项目，与私聊隔离
- 节点产物（文档 / MR / 文件）登记后自动注入后续节点的上下文
- 基线分支红线保护：只作切 feature 起点，禁止直接推送

### 多会话与多通道

- 私聊 / 群聊 / 项目 / 定时任务 / 临时会话并行运行，各自独立工作目录与上下文
- 多个飞书机器人 + 微信账号同时接入，每个通道独立配置模型、工作目录、保活策略
- 群聊里多个机器人可以互相 @ 派活（AI 间协作），消息自带协作机器人名册
- 为群聊和非主用户会话注入自定义**数字身份**（角色定义）

### 定时与自动化

- Cron 表达式定时任务：让 AI 每天自动巡检、写日报、跑脚本，支持独立会话模式
- `/c new <任务>` 随手开临时会话，执行完自动收尾回到原会话
- Agent 可通过 MCP 工具**自管理**：改自己的 MCP 配置、Rules、Skills、定时任务、工作目录

### 远程指令系统

不依赖 Agent 运行，直接由守护进程响应，每个指令都有单字母缩写：

| 指令 | 缩写 | 说明 |
|------|------|------|
| `/status` | `/s` | 查看运行状态（飞书返回可刷新的状态卡片） |
| `/chat` | `/c` | 会话管理：`ls` 列表 / `<序号>` 切换 / `new <描述>` 开临时会话 / `main` 回主会话 |
| `/project` | `/p` | 项目工作区：`new` / `ls` / `use` / `leave` 及各节点推进 |
| `/task` | `/t` | 定时任务：`ls` 列表 / `trigger <id>` 手动触发 |
| `/model` | `/m` | 模型管理：`ls` / `info` / `set <序号>`（仅当前会话生效） |
| `/mcp` | `/mc` | MCP 服务器管理：`ls` / `enable` / `disable` / `add` / `delete` |
| `/workspace` | `/w` | 查看 / 切换工作目录 |
| `/list` | `/ls` | 查看队列中的待处理消息 |
| `/stop` | `/x` | 停止运行中的 Agent |
| `/clean` | `/cl` | 清空消息队列 |
| `/reset` | `/r` | 重置会话（下次拉起不延续上下文） |
| `/restart` | `/rr` | 停止 Agent → 清空队列 → 重启守护进程 |
| `/help` | `/h` | 列出所有指令 |

## 安装

从 [Releases](../../releases) 页面下载对应平台的安装包：

| 平台 | 格式 | 备注 |
|------|------|------|
| Windows | `.exe` | 直接运行安装 |
| macOS (Intel) | `.dmg` | 首次打开需解除 Gatekeeper |
| macOS (Apple Silicon) | `.dmg` | 首次打开需解除 Gatekeeper |
| macOS (Homebrew) | `brew install --cask` | 推荐，便于升级管理 |
| Linux | `.deb` / `.AppImage` | 直接运行 |

#### macOS 首次启动：信任应用（必读）

应用未经过 Apple 公证，无论通过 `.dmg` 还是 Homebrew 安装，**首次打开都会被 Gatekeeper 拦截**（提示"无法打开，因为无法验证开发者"或"已损坏"）。建议安装完成后、首次启动前先解除：

```bash
# 方式一：命令行移除隔离属性（推荐先尝试）
xattr -cr /Applications/Cursor\ Claw.app
```

如果命令执行失败（如提示 `Operation not permitted` / `No such xattr`），或执行后打开仍被拦截，请改走系统设置手动信任：

1. 双击打开一次 **LK Harness**，触发拦截弹窗后点「完成」关闭（不要点「移到废纸篓」）
2. 打开「系统设置 → 隐私与安全性」，滚动到「安全性」区域
3. 找到"已阻止 LK Harness"的提示，点击「仍要打开」，在弹窗中再次确认

完成后即可在「应用程序」中正常启动。

#### macOS 通过 Homebrew 安装

##### 初次安装

```bash
# 1. 添加 tap
brew tap lk-eternal/tap

# 2. 信任 tap
brew trust --cask lk-eternal/tap/lk-harness

# 3. 安装
brew install --cask lk-harness
```

安装完成后按上方[「首次启动：信任应用」](#macos-首次启动信任应用必读)操作解除拦截，再在「应用程序」中打开 **LK Harness** 即可。

##### 更新到最新版本

```bash
brew update && brew upgrade --cask lk-harness
```

如果提示 `the latest version is already installed` 但实际版本较旧，请参考下方 FAQ。

##### 卸载

```bash
brew uninstall --cask lk-harness
brew untap lk-eternal/tap   # 可选，移除 tap 源
```

<details>
<summary>Homebrew FAQ</summary>

###### Q: `brew upgrade` 提示已是最新，但实际还是旧版本？

这是 Homebrew Cask 的常见问题，通常是本地 tap 缓存没有刷新。按以下步骤操作：

```bash
# 方法 1：强制刷新 tap 后重装
brew untap lk-eternal/tap
brew tap lk-eternal/tap
brew trust --cask lk-eternal/tap/lk-harness
brew upgrade --cask lk-harness

# 方法 2：直接强制重装
brew reinstall --cask lk-harness
```

###### Q: `brew update` 时出现 `Warning: No remote 'origin'` 导致 tap 无法更新？

```bash
brew untap lk-eternal/tap
brew tap lk-eternal/tap
brew trust --cask lk-eternal/tap/lk-harness
```

如果 `untap` 报错 `Refusing to untap because it contains installed casks`，加上 `--force`：

```bash
brew untap --force lk-eternal/tap
brew tap lk-eternal/tap
brew trust --cask lk-eternal/tap/lk-harness
brew upgrade --cask lk-harness
```

###### Q: 如何确认当前安装的版本？

```bash
brew info --cask lk-harness
```

###### Q: Apple Silicon 和 Intel Mac 都支持吗？

是的，Cask 会自动根据芯片架构下载对应的 dmg：Apple Silicon → `*-arm64.dmg`，Intel → `*.dmg`。

</details>

## 快速开始

1. 下载安装并启动应用
2. 按照 5 步向导完成配置：
   - **选工作文件夹**：选择 AI 的默认工作目录
   - **接入 AI**：填入 Cursor API Key（SDK 直跑，无需本机 IDE 常驻）
   - **连上飞书**：填入自建应用 App ID / App Secret，按引导开通权限与事件订阅
   - **绑定你自己**：私聊机器人完成主用户绑定
   - **装点工具**：一键安装 `lark-cli` / `meegle`（可跳过，之后在工具箱补装）
3. （可选）在设置页「消息通道」中添加更多飞书机器人或微信账号
4. 给机器人发条消息，开始协作；发 `/help` 查看全部指令
5. （可选）发送 `/p new` 创建项目工作区，体验节点化研发流程

## 工具箱：让 AI 打通飞书生态

设置页「工具箱」可一键安装 / 更新两个命令行工具，装好后 AI 即可直接操作飞书生态，无需写代码调 API：

<img src="docs/screenshots/toolbox.png" width="640" />

### lark-cli — 飞书全家桶 CLI

覆盖飞书开放平台绝大多数能力，AI 用它读写你的飞书数据：

- **文档**：读写云文档 / 知识库 / 云盘，读 PRD、写技术方案、同步变更说明
- **消息 / 群组**：搜索聊天记录、拉群、发卡片
- **日历 / 会议**：查日程、订会议室、拉取妙记纪要与逐字稿
- **表格 / 多维表格**：读写 Sheets 与 Base，做数据统计与报表
- **邮件 / 任务 / 审批 / OKR**：收发邮件、管理待办、发起审批流

### meegle — 飞书项目 CLI

飞书项目（Meegle）的 Agent-First 命令行：工作项、视图、流程、字段全量管理。AI 用它获取待办需求、更新工作项状态、生成进度报告。

两者配合项目工作区，即可串起「需求文档 → 技术方案 → 编码 → MR → 工作项流转」的完整链路。

## MCP 工具

应用自动向工作区注入 MCP 配置，Agent 开箱即用以下工具：

### 通信工具

| 工具 | 说明 |
|------|------|
| `send_text` | 发送文本消息，自动路由到飞书或微信 |
| `send_image` / `send_file` | 发送本地图片 / 文件 |
| `send_question` | 提问并附选项按钮（飞书卡片 / 微信文本降级） |

### 自管理工具

| 工具 | 说明 |
|------|------|
| `manage_agent` | 查询状态、停止 Agent、重启应用、重置会话、清空队列、启动临时会话 |
| `manage_mcp` | 管理 MCP 服务器配置 |
| `manage_rules` / `manage_skills` | 管理 Cursor Rules / Agent Skills |
| `manage_tasks` | 管理定时任务 |
| `manage_workspace` | 查看或切换工作目录（热更新生效） |

### 项目工具

| 工具 | 说明 |
|------|------|
| `project_get` / `project_list` | 查询项目详情 / 列出所有项目 |
| `project_update` | 更新项目元数据（目标、文档链接、分支信息等） |
| `project_register_artifact` | 登记节点产物，供后续节点注入上下文 |
| `project_delete` | 删除项目（连带移除 worktree，不动主仓与远程分支） |

## 设置页面

全部配置可视化，无需手写任何配置文件：

<img src="docs/screenshots/settings-channels.png" width="640" />

| Tab | 功能 |
|-----|------|
| 通用 | 主工作目录、开机自启、关闭窗口行为 |
| 网络 | HTTP/HTTPS 代理、NO_PROXY 配置 |
| Agent | Agent 资源管理（Cursor API Key / 本机 CLI）、默认模型 |
| 消息通道 | 多通道管理：凭据、主用户绑定、模型、工作目录、数字身份、群聊开关、保活策略 |
| 项目 | 项目列表、工作区与仓库配置、流程组与节点编辑、GitLab Token |
| MCP | MCP 服务器可视化管理（启停 / 编辑 / 认证 / 工具列表） |
| Rules / Skills | Cursor Rules 与 Agent Skills 文件管理 |
| 定时任务 | Cron 任务编辑、运行预览、手动触发 |
| 工具箱 | `lark-cli` / `meegle` 一键安装与更新、Node.js 环境检测 |
| 帮助引导 | 飞书权限 / 事件订阅配置参考、重新进入引导 |
| 关于 | 版本信息、检查更新 / 一键更新 |

## 平台接入配置

### 飞书

1. 前往 [飞书开放平台](https://open.feishu.cn/app/) 创建自建应用
2. 获取 App ID 和 App Secret
3. 添加「机器人」能力
4. 在「权限管理」中开通以下权限：

| 权限标识 | 用途 |
|----------|------|
| `im:message` | 发送消息（create / reply） |
| `im:message.p2p_msg:readonly` | 接收私聊消息 |
| `im:message.group_at_msg:readonly` | 接收群聊 @消息 |
| `im:message.group_at_msg.include_bot:readonly` | 接收其他机器人 @本机器人的群消息（AI 间协作） |
| `im:resource` | 上传/下载图片与文件 |
| `im:chat:read` | 获取群聊名称 |
| `im:chat:create` | 创建项目独立群 |
| `contact:contact.base:readonly` | 获取通讯录基本信息（需同时配置通讯录数据范围） |
| `contact:user.base:readonly` | 获取用户基本信息（姓名/昵称，私聊会话显示） |
| `cardkit:card:write` | 创建与更新 CardKit 流式卡片（Agent 进度卡） |

<details>
<summary>批量导入权限 JSON</summary>

```json
{
  "scopes": {
    "tenant": [
      "im:message",
      "im:message.p2p_msg:readonly",
      "im:message.group_at_msg:readonly",
      "im:message.group_at_msg.include_bot:readonly",
      "im:resource",
      "im:chat:read",
      "im:chat:create",
      "contact:contact.base:readonly",
      "contact:user.base:readonly",
      "cardkit:card:write"
    ],
    "user": []
  }
}
```

</details>

5. 在「事件订阅」中：
   - 选择 **「长连接」** 模式（无需配置回调 URL）
   - 添加 `im.message.receive_v1`（接收消息 v2.0）事件
   - 开通「读取用户发给机器人的单聊消息」
   - 开通「获取群组中用户@机器人消息」

   > **注意：** 配置事件订阅前需先启动应用，否则飞书无法验证 WebSocket 连接。
   > 卡片按钮回调（`card.action.trigger`）同样走长连接自动接收，无需额外配置回调地址。

6. 在「版本管理与发布」中发布应用

### 微信

1. 在设置页「消息通道」Tab 中添加微信通道
2. 填入 iLink Token 和 Account ID（从微信 iLink 平台获取）
3. 点击「连接」，扫码登录
4. 登录成功后微信消息即可与 Agent 交互

## 工作原理

三层结构，职责简单清晰：

- **Electron 应用**：可视化配置 + Agent SDK 会话池（`@cursor/sdk` 直跑，流式事件转进度卡）+ Cron 调度 + 项目 worktree 管理
- **守护进程（Daemon）**：飞书 WebSocket 长连接 / 微信长轮询收消息 → 落**文件消息队列**（至少一次投递）→ 本机 HTTP + MCP 服务供 Agent 收发消息
- **工作区注入**：自动写入 `.cursor/mcp.json`、Loop 协议规则与自管理 Skill，Agent 启动即具备全部远程协作能力

消息可靠性：消息先落盘再投递，Agent 挂阻塞 poll 才确认删除；掉线未确认的消息会重投给新会话。Agent 断开后守护进程自动拉起新会话，`Resume` 延续上下文。会话保活策略可按通道配置。

## 常见问题

<details>
<summary>Agent 会话为什么会断开？</summary>

常见原因：
- **上下文窗口超限**：超长会话会被自动截断，建议复杂任务拆分或使用 `.cursor/memory.md` 持久化关键信息
- **工具调用过多**：单次会话中工具调用次数过多可能触发安全机制
- **网络波动**：本地网络不稳定可能导致 SDK / MCP 通信中断

> 应用会在 Agent 断开后自动拉起新会话；未确认的消息不会丢失，会重投给新会话。

</details>

<details>
<summary>为什么飞书收不到消息？</summary>

请按顺序排查：
1. 确认添加了 `im.message.receive_v1` 事件订阅，且选择「长连接」模式
2. 确认已开通「读取用户发给机器人的单聊消息」和「获取群组中用户@机器人消息」
3. 确认应用已发布（未发布的应用无法接收消息）
4. 确认所有权限已添加并发布
5. 确认应用已启动且飞书 WebSocket 连接成功
6. 确认是在机器人私聊窗口或群聊 @机器人 发送消息

</details>

<details>
<summary>为什么微信收不到消息？</summary>

请按顺序排查：
1. 确认 iLink Token 和 Account ID 已正确填入设置页面
2. 确认已点击「连接」并成功扫码登录
3. 确认设置页面显示微信状态为「已连接」
4. 确认守护进程已启动

</details>

<details>
<summary>定时任务需要电脑一直开着吗？</summary>

是的，但可以锁屏或关闭显示器。定时任务由应用调度，需要应用保持运行。关闭窗口后应用会最小化到系统托盘继续运行，但完全退出或关机后定时任务不会触发。

</details>

<details>
<summary>群聊消息如何路由？</summary>

每个群聊会创建独立的 Agent 会话和工作目录。消息通过 `session_key` 路由到对应会话，Agent 回复时携带 `message_id` / `session_key` 确保消息发到正确的群。

</details>

## 注意事项

- **凭据安全**：App Secret / iLink Token / API Key 等敏感信息使用系统级加密（Windows DPAPI / macOS Keychain）落盘
- **网络要求**：需保持与飞书 / 微信服务器的网络连接，企业网络如有代理限制，可在设置中配置代理
- **AI 接入方式**：推荐使用 Cursor API Key（SDK 直跑）；也可绑定本机 Cursor CLI 作为 Agent 资源
- **应用隔离**：支持多开，通过启动参数 `--profile=xxx` 隔离多个应用数据

## 开发

```bash
# 安装依赖
npm install

# 开发模式
npm run dev

# 构建
npm run build

# 打包
npm run dist:win   # Windows
npm run dist:mac   # macOS
```

## License

MIT

## Star History

<a href="https://www.star-history.com/?repos=lk-eternal%2Flk-harness&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=lk-eternal/lk-harness&type=date&theme=dark&legend=top-left&sealed_token=WIlkJeujXI5zTfjw5krA3Q7_WbJQKuq02Bez7x6u-nxdu5ObaFvIRY77eXpAH_8MHRkB0SAp0iuuP6EWA4FtdmATTM2YL8InZi3vF5ovFW8LUHFBhb7Wurk-5Zyru4XI64YFZ0yUC4_tqmIiY6W454b7hjNGbDMdOND5iQ01bBBII6XDq9XHUNgMGa3G" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=lk-eternal/lk-harness&type=date&legend=top-left&sealed_token=WIlkJeujXI5zTfjw5krA3Q7_WbJQKuq02Bez7x6u-nxdu5ObaFvIRY77eXpAH_8MHRkB0SAp0iuuP6EWA4FtdmATTM2YL8InZi3vF5ovFW8LUHFBhb7Wurk-5Zyru4XI64YFZ0yUC4_tqmIiY6W454b7hjNGbDMdOND5iQ01bBBII6XDq9XHUNgMGa3G" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=lk-eternal/lk-harness&type=date&legend=top-left&sealed_token=WIlkJeujXI5zTfjw5krA3Q7_WbJQKuq02Bez7x6u-nxdu5ObaFvIRY77eXpAH_8MHRkB0SAp0iuuP6EWA4FtdmATTM2YL8InZi3vF5ovFW8LUHFBhb7Wurk-5Zyru4XI64YFZ0yUC4_tqmIiY6W454b7hjNGbDMdOND5iQ01bBBII6XDq9XHUNgMGa3G" />
 </picture>
</a>
