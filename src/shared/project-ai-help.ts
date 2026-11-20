// manage_project 的 help：写给 AI 看的「项目功能操作手册」。
// 用户多半第一次用，不知道要配什么、怎么建；AI 读完这份手册，就能用自然语言带着用户把项目配好、建好，
// 不用让用户去翻设置页。内容随应用版本走，tests/project-ai-help.test.ts 守着它说的模板、操作、参数名都真实存在。

export const PROJECT_HELP_TOPICS = ["overview", "create", "repos", "templates", "settings", "manage"] as const
export type ProjectHelpTopic = (typeof PROJECT_HELP_TOPICS)[number]

const OVERVIEW = `# LK Harness 项目功能：操作手册（给你，AI）

用户多半是第一次用：不知道要配什么、怎么建项目、模板和仓库是什么。你的任务是用对话把事办完，不要让用户去翻设置页，也不要甩术语。

## 先弄懂这几个概念（对用户说话时用括号里的叫法）
- 项目：一件事的独立工作空间 = 一个文件夹 + 一个独立的 AI 会话 + 一组快捷操作。适合把一件事从头做到尾（做一个需求、一次调研、一份周报……）。
- 项目模板（飞书里叫「流程组」）：决定建项目要填哪些信息、有哪些快捷操作、接不接代码仓库。内置 7 个：开发、测试（接代码仓库），通用任务、调研分析、文档写作、周报月报、活动策划（不接）。可以新建、修改。
- 快捷操作：模板里的一个个「按钮」，点一下把一段预设的工作要求交给 AI。只是常用请求的入口，没有先后顺序，用户随时可以直接用自然语言提。
- 常用代码仓库：登记过的 git 仓库（本地路径或远程地址）+ 基线分支（新分支从哪切出）+ 可选的测试 / 开发分支 + 建项时要不要克隆副本。建项目时直接选；建过项目用到的仓库会自动登记。
- 项目存放位置：每个新项目会在这里建自己的文件夹。有默认位置，不用配也行。
- Git 基本原则：项目里有代码仓库时，每个项目会话开头带给 AI 的几条 Git 守则（别合错分支、别 force push 等）。默认就有，团队有自己的习惯再改。
- GitLab Token / 地址、共享空间：都是可选的，只在团队要共享项目模板时用。不影响建项目、改代码、推分支；用户没提就不要主动让他配。

## 帮用户建项目：完整流程
1. 先自己摸底，别问用户能查到的：templates 看有哪些模板；用户要接代码时 repos 看常用仓库。
2. 把缺的信息问齐（用 send_question 给选项，一次最多问 3 件事）：
   - 这个项目是做什么的 → 对上合适的模板；没有合适的，问用户要不要为这类事新建一个模板（help topic=templates），别硬套。
   - 项目名称、一两句话的目标。
   - 模板里标「必填」的信息：不要替用户编，他没说就问。
   - 接代码仓库的模板：要接哪个仓库、基线分支。仓库不在常用列表里，先 repo_save 登记（help topic=repos）。
   - 项目接入哪些聊天 bindings：先 channels 看你在哪个通道、能把项目接到哪些通道和各自能用的方式，再问用户「项目放哪」：就放在当前聊天里（主聊天）/ 建一个独立的飞书群 / 绑定一个已有的群 /（应用内对话里才有）也接到别的通道。一个项目可以同时接多个通道，每个通道各自一条独立会话。
3. 创建前把整理好的内容（名称、目标、模板、各项信息、仓库和分支、接入的聊天）一起发给用户确认，确认后才 create。细节见 help topic=create。
4. 建完告诉用户：项目叫什么、放在哪、接入了哪些聊天、接下来怎么进（主聊天里的项目在应用里点项目 / 飞书微信里发 /p use 项目ID；群里的项目到群里聊）。
5. 失败了把原因原样告诉用户，并说清怎么办（常见：仓库路径不是 git 根目录、分支不存在、必填项没填），不要自己改参数重试。

## 用户说的话 → 你该做什么
- 「帮我建个项目」「我想做一个XX」→ 上面的完整流程。
- 「把 D:\\xxx 加到常用仓库」「加个仓库」→ help topic=repos，repo_save。
- 「项目都放到 D 盘」「改项目存放位置」→ settings_set 的 worktree_root（help topic=settings）。
- 「配 GitLab」「共享空间」「改 Git 原则」→ help topic=settings。
- 「我想要个XX模板」「给模板加个操作」「改提示词」→ help topic=templates。
- 「我有哪些项目」「改项目名」「归档」「删了」→ help topic=manage。
- 「这个怎么用」「要配什么」→ 先 settings 看现状，按现状一步步带，不要一次倒出全部。

## 和用户说话的方式
- 用户是新手：先说结论再给选项；用大白话（说「基线分支」「常用仓库」，别说 worktree、snapshot、metadata）。
- 能自己查的先查（list / templates / repos / settings），别问用户。
- 动手前确认：新建、删除、改模板、改设置，先说清要做什么、影响什么；只读的随便做。
- 做完说清楚改了什么、现在是什么状态、下一步建议什么。
- 密钥（GitLab Token 等）：用户发来后直接 settings_set，回复里不要重复原文，也不要写进任何文件；顺带提醒一句这条消息会留在聊天记录里，介意的话可以事后到 GitLab 换一个新 Token，或自己在 设置 → 项目 里填。

## 这些工具目前做不到（需要用户自己到 设置 → 项目 里操作，如实说）
给已有项目换模板；模板的导入 / 导出和共享空间上传 / 下载；给飞书里已建好的独立群改名或解散。`

const CREATE = `# 创建项目（create）细节

## 参数从哪来
- template_id：templates 里的 id。fields：键是模板里「要填的信息」的名字（原样用），值是内容；必填的缺了会被拒。
- repos：[{ repo_path, base_branch }]，只有接代码仓库的模板有效，可以一个都不选。repo_path 用 repos 里列出的路径，也可以是没登记的本地 git 根目录（绝对路径）或远程地址；base_branch 必填，常用仓库用它登记的那个，用户另有要求按用户的。最多 6 个。
- work_branch：克隆副本停在哪个分支，new=新建分支 / base=基线 / test=测试分支 / develop=开发分支；不给就用模板默认值。new 时可以给 feature_branch，不给自动生成。只想看代码的人（比如测试）选 test。
- folder：只有不接代码仓库的模板可用，用一个已有文件夹当项目目录（绝对路径），应用不会改动里面的文件；不给就在项目存放位置下新建。
- story_url / related_docs：需求链接、相关文档，可选。
- bindings（必填，没有默认值，用户没说清楚就问）：项目接入哪些聊天，数组，每项 { channel_id, mode, group_chat_id? }。先用 channels 看你在哪个通道、能接哪些通道、各自能用什么方式。mode：inline=接这个通道的主聊天（不建群）；group=新建飞书独立群并把用户拉进去（用户是群主，之后在群里协作）；bind=绑定已有的飞书群（还要 group_chat_id，oc_ 开头，机器人要已经在群里）。一个项目可以同时接多个通道，每个通道各自一条独立会话，互不通消息；没接入的通道里看不到这个项目。
- 能接哪些通道：应用内对话里的你可以接任何通道；飞书 / 微信里的你只能接自己所在的通道。微信只有 inline，group / bind 只有飞书能用，要新建群还需要记录到主用户的飞书身份（channels 的 note 会写）。

## 确认环节
把名称、目标、模板、各项信息、仓库和分支、文件夹、接入的聊天（每个通道选了什么）列成一份清单发给用户确认（send_question），确认后才调用。克隆仓库可能要几分钟，调用期间别重复提交。

## 建完怎么说
- 返回里逐个通道列出了结果，原样转述：接了主聊天的，没有进入项目会话、当前对话不受影响，告诉用户项目 ID，他需要时自己进入；建了群 / 绑了群的，告诉用户到那个群里协作。
- 返回里带 warning 的（比如建群没成功）要如实转述，由用户决定怎么处理：补接用 bind，不想要了用 delete。

## 常见失败
- 「不是 git 仓库的根目录」：路径要指到仓库最外层（里面直接有 .git）。
- 基线分支不存在：问用户正确的分支名，不要猜。
- 必填信息缺：回去问用户。
- 同名项目正在创建：用 list 确认，别重复提交。`

const REPOS = `# 常用代码仓库（repos / repo_save / repo_remove）

- 先 repos 看已登记的。建项目时用过的仓库会自动登记，所以用户常常不需要提前配。
- 登记：action=repo_save，repo={ repo_path, base_branch?, test_branch?, develop_branch?, clone? }。
  - repo_path：本地 git 仓库的「根目录」绝对路径（里面直接有 .git），或远程地址（https:// / ssh:// / git@）。用户只说了仓库名没给路径时，问他，别猜路径。
  - base_branch：新分支从哪切出去，一般是主干或生产分支（main / master / 线上分支）。本地仓库不给会自动用它的默认分支（登记后和用户确认一下）；远程地址没法自动识别，必须问用户。
  - test_branch / develop_branch：可选，研发流程里提测、联调用。用户没提就不填，不要猜。
  - clone：默认克隆一份副本到项目目录，AI 在副本里改，不动用户自己的仓库（推荐）。clone=false 是不克隆，只把仓库信息记进项目，AI 直接用用户本机这份——只有用户明确要「AI 直接改我本地的仓库」时才用。远程地址一定克隆。
- 修改：对同一个路径再 repo_save，只给要改的项；要清掉测试 / 开发分支就传空字符串。
- 移除：action=repo_remove，repo={ repo_path }。只是从常用列表去掉，不删磁盘上的仓库，已建项目不受影响；先和用户确认。
- 常见失败：路径不存在、不是仓库根目录、分支名不合法。把原因告诉用户，让他确认路径。`

const TEMPLATES = `# 项目模板（templates / template_save / template_delete）

- 看：templates 列出全部；templates + template_id 看一个模板的完整内容（要填的信息、每个快捷操作的提示词概况）；再加 action_id 看某个操作的提示词全文。
- 新建：action=template_save，不给 template_id，template={ name（必填）, description?, needs_repo?, work_branch?, fields?, actions? }。
  - needs_repo：要不要接代码仓库。写代码 / 测试类 true，其余 false（默认 false）。只有 true 时才能设 work_branch。
  - fields：建项时要用户填的信息，最多 8 项，名字不重复。每项 { label, placeholder?（例子，别写太长）, required?, multiline? }。只放「开工前必须知道」的，别塞太多。
  - actions：快捷操作列表，至少 1 个，名字 ≤40 字且不重复。每项 { label, prompt }：prompt 是点这个操作时交给 AI 的工作要求，要具体：做什么、参考哪些信息、产出什么、成果放哪、缺信息怎么办。不给 actions 会自动放一个「开始」。
- 帮用户设计模板：先问他这类事一般怎么推进（3~5 步）、每步产出什么、开工前要先知道什么；由你起草整套模板发给他确认，再保存。不要让他自己写提示词。
- 修改：template_save + template_id，只给要改的项。fields 和 actions 一旦给了就是完整新列表：actions 的顺序就是展示顺序，没列出的已有操作会被删掉。保留已有操作就带它的 id（或原来的名字），不给 prompt 就保持原提示词；新增的操作必须给 prompt。改之前先 templates + template_id 看现状，改完把变化告诉用户。
- 删除：template_delete + template_id。至少要留 1 个模板；还有老项目直接跟着它走的删不了。删之前先确认。
- 改了模板，已经建好的项目不受影响（建项时复制过一份快捷操作）；要让某个项目用上新版，用 action=sync_steps。
- 内置模板（开发、测试等）也可以改；它们的快捷操作没写自定义提示词时，用应用内置的默认提示词。`

const SETTINGS = `# 全局设置（settings / settings_set）

- 看：action=settings，列出现状，密钥只显示打码。
- 改：action=settings_set，settings={ ... }，只给要改的项；空字符串表示清空 / 关闭 / 恢复默认。
  - worktree_root：项目存放位置，绝对路径，不存在会自动创建，不能是整个盘。只影响之后新建的项目，已有项目不搬家；空字符串 = 改回默认位置。
  - git_principles：Git 基本原则全文（≤4000 字，它会带进每个项目会话）；空字符串 = 关闭；reset_git_principles=true = 恢复默认（和 git_principles 二选一）。要在现有基础上增减，先 settings 看正文再改。
  - gitlab_host：GitLab 地址，只写域名部分（https://gitlab.example.com）；gitlab_token：GitLab Token。两个都可选，只在用共享空间时用。
  - flow_hub_url / flow_hub_token / flow_hub_author：共享空间（团队共用的模板仓库）的地址、Token（需要 Maintainer 及以上权限；不填会改用 gitlab_token）、署名。
- 用户要配共享空间，通常是同事给了一个仓库地址和 Token：问清地址和 Token，各自 settings_set。配完说一声：模板的上传 / 下载目前要用户在 设置 → 项目 里操作。
- 密钥处理：用户发来后直接写入，回复里不要重复原文；提醒他这条消息会留在聊天记录里。`

const MANAGE = `# 管理已有项目（list / get / update / archive / delete / sync_steps / channels / bind / unbind）

- 项目按消息通道隔离：只有接入了某个通道（主聊天或专属群）的项目，那个通道里的人和你才看得到、管得了。集中部署时，不同通道的人互相看不到对方的项目。
- list：你所在通道下的项目和 ID；get + project_id：一个项目的完整资料（目标、模板、目录、接入的聊天、项目信息、快捷操作）。
- channels：看你在哪个通道、能把项目接到哪些通道、各自能用什么方式。
- bind + project_id + bindings：给项目补接入（写法同 create 的 bindings）：比如再接一个飞书通道、新建一个独立群、绑一个已有的群。已经接着的主聊天不会重复接，通道上已有专属群时不会再新建一个。
- unbind + project_id + bindings（放一项 { channel_id, mode, group_chat_id? }，inline=主聊天，group / bind=专属群）：取消项目在那里的接入，那条会话（含应用内的聊天记录）会一并清理，群本身不改名、不解散。项目至少要留一个接入，取消前先问用户。
- update + project_id：改 name、goal、story_url、related_docs，以及 fields（项目信息，键值，合并写入；值为空字符串 = 删掉这一项，仓库和分支也记在项目信息里）。只给要改的项。改名不会改项目目录名。
- archive + project_id + archived=true/false：归档 / 取消归档。做完了想留着成果的项目建议归档，不要删；归档后不再认领飞书专属群，会话和成果都还在。
- sync_steps + project_id：把项目的快捷操作同步成模板最新版（只对有自己快捷操作副本的项目有意义）。
- delete + project_id：不可恢复地删除项目（项目目录含克隆的代码副本移到回收站，用户自己的仓库和远程分支不动）。删之前一定先问用户，并说清会发生什么；用户只是「做完了」时优先建议归档。
- 用户怎么进入项目：应用里在项目列表点开；飞书 / 微信里发 /p use 项目ID；绑了群的项目只能在群里进入和推进。`

const BY_TOPIC: Record<ProjectHelpTopic, string> = {
  overview: OVERVIEW,
  create: CREATE,
  repos: REPOS,
  templates: TEMPLATES,
  settings: SETTINGS,
  manage: MANAGE,
}

/** 手册正文：不给 topic 是总览（含完整建项目流程）；其余是各块的细节 */
export function buildProjectHelp(topic?: string): { ok: true; text: string } | { ok: false; error: string } {
  const t = (topic ?? "").trim() || "overview"
  if (!(PROJECT_HELP_TOPICS as readonly string[]).includes(t)) {
    return { ok: false, error: `没有「${t}」这个主题，可选：${PROJECT_HELP_TOPICS.join(" / ")}` }
  }
  const text = BY_TOPIC[t as ProjectHelpTopic]
  const others = PROJECT_HELP_TOPICS.filter((x) => x !== t)
  return { ok: true, text: `${text}\n\n（其它主题：${others.map((x) => `help topic=${x}`).join("、")}）` }
}
