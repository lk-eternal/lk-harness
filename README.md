# LK Harness

LK Harness 是一款桌面应用，通过飞书或微信与 AI Agent 远程协作：在手机上收发消息、查看执行进度、处理待办决策，会话可在后台持续运行。

产品介绍：<https://lk-ai.top/harness>

## 功能概览

### 远程协作

- 飞书机器人 / 微信账号接入，Agent 在指定工作目录执行任务，结果回到 IM
- 支持文本、图片、文件双向传输
- 需要用户选择时发送选项卡片；也可直接回复文字
- 消息至少一次投递：Agent 异常退出或应用重启后，未确认的消息会重投

### 流式进度

- 思考过程与工具调用按时间线展示在一张卡片中
- 可按通道关闭思考过程展示

### 项目工作区

- 一个项目对应独立 git worktree（可多仓）、feature 分支与会话
- 节点化流程：规划、实现、审查、部署、提测等（节点组可配置）
- 可创建项目专属飞书群，消息路由到该项目
- 节点产物可登记并注入后续节点上下文

### 多会话与多通道

- 私聊、群聊、项目、定时任务、临时会话并行，各自独立工作目录
- 多个飞书机器人与微信账号可同时接入
- 群聊内多个机器人可互相 @ 协作
- 支持为会话配置数字身份（角色定义）

### 定时与自动化

- Cron 定时任务，支持独立会话模式
- `/c new` 创建临时会话，任务结束后自动收尾
- Agent 可通过 MCP 管理 MCP 配置、Rules、Skills、定时任务、工作目录

### 远程指令

| 指令 | 缩写 | 说明 |
|------|------|------|
| `/status` | `/s` | 运行状态 |
| `/chat` | `/c` | 会话管理 |
| `/project` | `/p` | 项目工作区 |
| `/task` | `/t` | 定时任务 |
| `/model` | `/m` | 模型管理（当前会话） |
| `/mcp` | `/mc` | MCP 服务器管理 |
| `/workspace` | `/w` | 工作目录 |
| `/list` | `/ls` | 待处理消息 |
| `/stop` | `/x` | 停止 Agent |
| `/clean` | `/cl` | 清空队列 |
| `/reset` | `/r` | 重置会话 |
| `/restart` | `/rr` | 重启守护进程 |
| `/help` | `/h` | 指令列表 |

## 安装

从 [Releases](../../releases) 下载对应平台安装包：

| 平台 | 格式 |
|------|------|
| Windows | `.exe` |
| macOS | `.dmg` 或 Homebrew Cask |
| Linux | `.deb` / `.AppImage` |

### macOS 首次启动

应用未经 Apple 公证，首次打开可能被 Gatekeeper 拦截：

```bash
xattr -cr /Applications/LK\ Harness.app
```

若仍无法打开：系统设置 → 隐私与安全性 → 仍要打开。

### Homebrew（macOS）

```bash
brew tap lk-eternal/tap
brew trust --cask lk-eternal/tap/lk-harness
brew install --cask lk-harness
```

更新：`brew update && brew upgrade --cask lk-harness`

## 快速开始

1. 安装并启动应用
2. 按引导完成：工作目录、Agent 资源（API Key 或本机 CLI）、飞书凭据、主用户绑定
3. （可选）在「消息通道」添加更多机器人或微信账号
4. 向机器人发送消息开始协作；发送 `/help` 查看指令

## 飞书接入

1. 在[飞书开放平台](https://open.feishu.cn/app/)创建自建应用，获取 App ID / App Secret
2. 添加机器人能力，开通消息、资源、通讯录、CardKit 等权限（详见应用内帮助引导）
3. 事件订阅选择**长连接**，添加 `im.message.receive_v1`
4. 发布应用后在 LK Harness 中填入凭据并启动

## 微信接入

在设置页添加微信通道，填入 iLink Token 与 Account ID，扫码登录即可。

## 架构

- **Electron 应用**：配置界面、Agent 会话调度、定时任务、项目 worktree 管理
- **守护进程**：IM 长连接收消息 → 文件队列 → 本机 HTTP / MCP 供 Agent 收发
- **工作区注入**：自动写入 MCP 配置、协作协议与 Skills

## 开发

```bash
npm install
npm run dev
npm run build
```

## License

MIT
