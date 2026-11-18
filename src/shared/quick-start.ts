/**
 * 「快速上手」：飞书 / 微信里给不熟悉的用户讲清楚「我能干什么、长期的事怎么建项目、先要配什么」。
 *
 * 三处共用同一份说法，免得各改各的：
 * - 主用户绑定成功后发的欢迎卡（electron/quick-start-card.ts）
 * - `/help` 的正文和按钮
 * - 还没有任何项目时 `/p` 的空状态
 *
 * 只有文字和按钮定义，不碰磁盘和网络。按钮的 cmd 都是已有的指令（/p new、/p setup、/p、/h）。
 */

export interface GuideButton {
  label: string
  cmd: string
  /** 分组标题（飞书插在按钮前，微信列表分段） */
  section?: string
}

export interface GuideCard {
  text: string
  buttons: GuideButton[]
  title?: { title: string; subtitle?: string }
}

const INTRO =
  "直接发消息给我（大白话就行，不用记指令），我就在你电脑上干活：写代码、查资料、改文件、整理文档都行；需要你拍板时我会发选项卡片，点一下就行。"

/**
 * 项目是什么、怎么建、要不要先配东西——用户最常卡住的三件事。
 * 说法以「直接跟我说」为主（建项目、配仓库、看配置、改模板 AI 都能代办，见 manage_project），按钮只是不想打字时的备选。
 */
const PROJECT_GUIDE: string[] = [
  "📦 要做一阵子的事，建个「项目」",
  "项目有自己的文件夹和对话，还有一排流程按钮（研发：规划 → 实现 → 审查 → 部署；也有调研、写作、周报、活动策划等模板），飞书里还可以建专属群协作。",
  "建项目、配仓库都不用记指令，直接跟我说：",
  "• 「帮我建个项目」——缺什么我会问你",
  "• 「把 D:/code/demo 加到常用仓库」——做研发要接代码仓库，登记一次就行",
  "• 「看看项目现在都配了什么」——目录、仓库、模板一目了然",
  "• 「把开发模板的审查步骤改成……」——模板也能直接让我改",
  "不接代码仓库的模板什么都不用先配。不想打字，也可以点「新建项目」「配置仓库/目录」。",
]

const NEW_PROJECT: GuideButton = { label: "🆕 新建项目", cmd: "/p new" }
/** /p setup 总览：项目目录、常用代码仓库、GitLab */
const SETUP_REPOS: GuideButton = { label: "⚙️ 配置仓库/目录", cmd: "/p setup" }

/** 主用户绑定成功后的欢迎卡（飞书是按钮卡，微信自动降级成「发送：指令」列表） */
export function buildWelcomeCard(): GuideCard {
  return {
    title: { title: "快速上手", subtitle: "欢迎" },
    text: [
      `👋 ${INTRO}`,
      "",
      ...PROJECT_GUIDE,
      "",
      "💡 想再看一遍，发 /help；会话、定时任务、切换模型也都在那里。",
    ].join("\n"),
    buttons: [
      { ...NEW_PROJECT, section: "▶ 项目" },
      { label: "📦 我的项目", cmd: "/p", section: "▶ 项目" },
      { ...SETUP_REPOS, section: "▶ 项目" },
      { label: "📖 全部指令", cmd: "/h", section: "▶ 更多" },
    ],
  }
}

/** /help 给主用户的正文：先说「直接发消息就行」，再点一下项目；比欢迎卡短，每次打开都不嫌啰嗦 */
export function buildHelpBodyForAdmin(): string {
  return [
    "💡 直接用大白话跟我说就行，不用记指令；也可以点下面按钮，有下级选项的会先说明用法。",
    "📦 要做一阵子的事，建个项目：对我说「帮我建个项目」，或点「🆕 新建项目」。",
    "🔧 配仓库、改模板、看配置也一样直说，比如「把 D:/code/demo 加到常用仓库」。",
  ].join("\n")
}

/**
 * /help 的按钮：当前对话 / 排队 / 协作 / 系统四组。
 * 非主用户只留状态、停止、重置三个（别的指令他们也用不了）。
 */
export function buildHelpButtons(isAdmin: boolean): GuideButton[] {
  const ctx: GuideButton[] = [
    { label: "📊 状态", cmd: "/s", section: "▶ 当前对话" },
    { label: "⏹ 停止", cmd: "/x", section: "▶ 当前对话" },
    { label: "🔄 清空上下文", cmd: "/r", section: "▶ 当前对话" },
    { label: "🧠 切换模型", cmd: "/m", section: "▶ 当前对话" },
  ]
  if (!isAdmin) return ctx.filter((b) => ["/s", "/x", "/r"].includes(b.cmd))
  const queue: GuideButton[] = [
    { label: "📋 查看排队", cmd: "/ls", section: "▶ 排队中" },
    { label: "🧹 清空排队", cmd: "/cl", section: "▶ 排队中" },
  ]
  const orch: GuideButton[] = [
    { label: "💬 会话", cmd: "/c", section: "▶ 协作" },
    { label: "⏰ 任务", cmd: "/t", section: "▶ 协作" },
    { label: "📦 项目", cmd: "/p", section: "▶ 协作" },
    { ...NEW_PROJECT, section: "▶ 协作" },
  ]
  const infra: GuideButton[] = [
    { label: "🧩 MCP", cmd: "/mc", section: "▶ 系统" },
    { label: "♻️ 重启应用", cmd: "/rr", section: "▶ 系统" },
  ]
  return [...ctx, ...queue, ...orch, ...infra]
}

/**
 * 还没有任何项目时 `/p` 的内容：讲清项目是什么、怎么建，而不是甩一串子指令。
 * 子指令说明仍可通过「指令说明」按钮（/p help）看到。
 */
export function buildEmptyProjectMenu(): GuideCard {
  return {
    title: { title: "项目", subtitle: "菜单" },
    text: ["📭 还没有项目", "", ...PROJECT_GUIDE].join("\n"),
    buttons: [
      { ...NEW_PROJECT },
      { ...SETUP_REPOS },
      { label: "📖 指令说明", cmd: "/p help" },
    ],
  }
}
