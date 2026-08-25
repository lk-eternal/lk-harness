import { isPlainProject, projectRootDir, type Project, type ProjectActionType, type ProjectRepo } from "../src/shared/project-types.js"
import { getProjectNode, getProjectNodes, projectNodeLabel, projectGroupIds } from "../src/shared/project-store.js"

// ════════════════════════════════════════════════════════════
// 项目工作流提示词模板（集中在此文件，改文案只动这里）
// ════════════════════════════════════════════════════════════

/** 默认节点的默认工作要求；改过提示词的节点以节点表为准 */
const ACTION_GUIDES: Record<string, string[]> = {
  plan: [
    "产出可执行的实现方案。用户刚立项，需求细节在飞书项目工作项与产品/技术文档里，不在本会话中：",
    "- 先读上下文：用 meegle 解析上文飞书项目链接读工作项详情与评论，用 lark-cli 读产品/技术文档；关键信息缺失时列出具体问题问用户，禁止凭空规划",
    "- 需求拆解与验收标准",
    "- 技术方案（数据结构 / 接口 / 关键流程），有取舍时给出理由",
    "- 影响面与风险点",
    "- 按依赖排序的任务清单",
  ],
  build: [
    "按最近一次通过的规划实现代码（无规划产物时先读飞书项目工作项与技术文档补齐上下文，仍不明确就问用户）：",
    "- 在 AI 工作目录内编码并本地验证（编译 / 测试 / 关键路径自测）",
    "- 提交到 feature 分支，提交信息说明动机",
    "- 产物写实现说明：改了什么、为什么、如何验证、遗留事项",
  ],
  review: [
    "审查 feature 分支相对基线的全部改动：",
    "- 正确性、边界条件、异常处理",
    "- 与需求 / 技术文档的一致性",
    "- 编码规范与可维护性",
    "- 产物写审查报告：结论（通过 / 有条件通过 / 不通过）+ 按严重度分级的问题清单",
  ],
  deploy: [
    "部署到开发分支：",
    "- 核对全部改动已提交 feature 分支，推送 feature 到 origin 同名分支",
    "- 在 AI 工作目录执行 git push origin HEAD:<开发分支全名> 推送到配置的开发分支",
    "- 被拒（non-fast-forward）时用临时合流分支解决，feature 分支必须保持纯净：",
    "  1. git fetch origin",
    "  2. git checkout -b <feature名>-deploy origin/<开发分支全名>（从远端开发分支拉临时分支）",
    "  3. git merge <feature分支全名>（在临时分支上解决冲突并提交）",
    "  4. git push origin HEAD:<开发分支全名>，然后 git checkout 回 feature 分支（临时分支可删）",
    "- 红线：严禁把开发分支 merge/rebase 进 feature 分支——feature 会被灌入开发分支上他人未上线内容，后续提测/上线全部被污染",
    "- 禁止 force push",
    "- 产物写部署摘要：推送分支、关键 commit、部署后验证方式",
  ],
  mr: [
    "提测：推送代码、创建指向测试分支的 MR：",
    "- 推送 feature 到 origin 同名分支",
    "- 创建 feature → 测试分支的 MR：在 AI 工作目录执行 git push origin HEAD -o merge_request.create -o merge_request.target=<测试分支全名> -o merge_request.title=\"Draft: <项目名>\"，命令输出中会返回 MR 链接",
    "- push option 建不出 MR 时改用 glab CLI；仍不行则给出 GitLab 新建 MR 页面链接引导用户手动创建，拿到 MR 链接后继续",
    "- 建完 MR 必查冲突（glab/API 看 has_conflicts / merge_status，detected_merge_conflicts 即有冲突），有冲突时用临时合流分支解决，feature 必须保持纯净：",
    "  1. git fetch origin && git checkout -b <feature名>-mr origin/<测试分支全名>",
    "  2. git merge <feature分支全名>（在临时分支上解决冲突并提交）",
    "  3. git push origin <feature名>-mr 并改建「<feature名>-mr → 测试分支」的 MR（关闭原冲突 MR），后续提测信息用新 MR 链接",
    "  4. git checkout 回 feature 分支；严禁把测试分支 merge/rebase 进 feature",
    "- 将 MR 信息（链接 / 源分支 / 目标分支 / 变更摘要）发送出来",
    "- 禁止勾选删除源分支，说明 feature 要保留",
    "- push option 不加 merge_request.remove_source_branch；默认仍勾选时用 glab/API 改 false",
    "- glab 必须带 --remove-source-branch=false",
  ],
  "submit-test": [
    "提测：推送代码、创建指向测试分支的 MR，并让测试同学在飞书项目里看到完整提测信息：",
    "- 推送 feature 到 origin 同名分支",
    "- 创建 feature → 测试分支的 MR：在 AI 工作目录执行 git push origin HEAD -o merge_request.create -o merge_request.target=<测试分支全名> -o merge_request.title=\"Draft: <项目名>\"，命令输出中会返回 MR 链接",
    "- **禁止勾选「删除源分支」**：feature 需保留供后续修复缺陷/迭代；push option 不要加 merge_request.remove_source_branch；若 GitLab 项目默认仍勾选，建完后执行 glab mr update --remove-source-branch=false（或 API 设 remove_source_branch=false）",
    "- push option 建不出 MR 时改用 glab CLI（必须带 --remove-source-branch=false）；仍不行则给出 GitLab 新建 MR 页面链接引导用户手动创建（手动创建时也取消勾选删除源分支），拿到 MR 链接后继续",
    "- 建完 MR 必查冲突（glab/API 看 has_conflicts / merge_status，detected_merge_conflicts 即有冲突），有冲突时用临时合流分支解决，feature 必须保持纯净：",
    "  1. git fetch origin && git checkout -b <feature名>-mr origin/<测试分支全名>",
    "  2. git merge <feature分支全名>（在临时分支上解决冲突并提交）",
    "  3. git push origin <feature名>-mr 并改建「<feature名>-mr → 测试分支」的 MR（关闭原冲突 MR），后续提测信息用新 MR 链接",
    "  4. git checkout 回 feature 分支；严禁把测试分支 merge/rebase 进 feature",
    "- 将 MR 信息（链接 / 源分支 / 目标分支 / 变更摘要）评论到本项目的需求工作项",
    "- 评论 @ 测试人员必须真正生效，缺一步都会变成纯文本、对方收不到通知：",
    "  1. 逐个查测试人员拿 lark_user_id（meegle user search / search_user_info）",
    "  2. content 中每个 @ 都写成 mention 格式：@名字<!-- mention:{\"id\":\"<lark_user_id>\",\"cn_name\":\"<名字>\",\"blockType\":\"AT_USER_BLOCK\"} -->",
    "  3. 评论同时传 notify_user_list=[全部被 @ 人的 lark_user_id] 与 notify_user_type=lark_user_id",
    "- 测试人员从工作项团队 / 角色字段获取；找不到时在产物中说明并提醒用户手动通知",
    "- 注意：API 评论的 @ 只在页面高亮、不触发飞书推送提醒——完成后必须在给用户的回复中提醒其手动转发提测信息给测试人员",
    "- 产物写提测说明：MR 链接、变更摘要、测试建议与关注点",
    "- 需要时可用 project_register_artifact 登记产物并附带 mr_url，供后续节点注入",
  ],
  "analyze-bug": [
    "分析缺陷。用户点击时测试已提了缺陷、指派给了自己，缺陷内容在飞书项目里不在本会话中：",
    "- 从本项目关联的飞书项目空间拉取缺陷类工作项，筛选：指派人为当前用户、状态未完成；拉不到或为空时如实说明，禁止编造",
    "- 读每个缺陷的描述 / 复现步骤 / 附件截图，结合代码定位根因，评估影响面与修复思路",
    "- 产物写缺陷分析报告：缺陷清单（标题/链接(格式: https://project.feishu.cn/wk-dm/bug/detail/xxxxxxx)/级别）、根因分析、修复方案、风险与依赖",
  ],
  "fix-bug": [
    "修复缺陷（以最近一次通过的缺陷分析报告为准；无报告时先拉取指派给自己的待解决缺陷，拉不到则如实说明）：",
    "- 逐个缺陷：按分析报告定位根因 → 在 AI 工作目录内修复 → 本地验证（编译 / 测试 / 关键路径自测），禁止未验证就收尾",
    "- 每个缺陷单独提交到 feature 分支（提交信息注明缺陷标题与工作项 ID），推送 feature 到 origin 同名分支",
    "",
    "【MR——只认「合并到测试分支」这一条】",
    "- 评论/产物里允许出现的 MR 有且仅有：源分支=本项目 feature、目标=配置的测试分支、且状态为 open（未合并）",
    "- 获取方式：project_get 查 lastMrUrl → 用 glab/API 核对 target 与 state；对不上或已 merged 一律作废",
    "- 没有合格 open MR 时必须新建：git push origin HEAD -o merge_request.create -o merge_request.target=<测试分支全名> …（与提测节点相同，禁止 merge_request.remove_source_branch）；建不出再用 glab --remove-source-branch=false；禁止开往生产基线/release",
    "- 建完 MR 必查冲突（has_conflicts / merge_status）：有冲突时按提测节点的临时合流分支方案处理（从测试分支拉临时分支合入 feature 解决，改建临时分支 → 测试分支的 MR）；严禁把测试分支 merge/rebase 进 feature",
    "- 严禁：贴已 merged 的旧 MR、贴合到 release/基线的 MR、贴其它需求/其它分支的 MR、把「曾经合过」的 MR 当本次修复凭证",
    "",
    "【缺陷评论——必须中文，写清楚，别吓人】",
    "- 评论全文使用中文（专有名词/路径/commit/MR 链接可保留原文）",
    "- 结构建议：① 问题原因（根因，结合代码说明为什么会坏）② 修复逻辑（改了什么、如何避免再发）③ 本地如何验证 ④ 关联 commit ⑤ 提测 MR 链接（仅上述合格 MR）⑥ 明确一句「代码尚未合入测试环境，请合入测试后再复测」",
    "- @ 提缺陷人按提测节点的 mention 三步；信息不足只评论不瞎编",
    "",
    "【状态流转红线】",
    "- 未合入测试分支前：禁止流转到「待验证」「已解决」「RESOLVED」等，保持处理中，只发中文进度评论",
    "- 仅当修复已出现在测试分支（MR 已合入，或用户明确说测试环境已有该修复）后，才可转待验证并 @ 提缺陷人",
    "- 无权限或不确定态机时：只评论、不流转，提醒用户手动处理",
    "",
    "- 产物写修复说明（中文）：每缺陷的原因、修复逻辑、验证方式、所用测试分支 MR、是否已允许流转、遗留事项",
  ],
  "fill-release-doc": [
    "填写上线文档。团队共用一份上线文档（多人并发编辑），本节点只填当前用户负责的部分，严禁改动他人内容：",
    "- 上线文档链接：会话上下文中没有时先向用户索要，禁止猜测",
    "- 当前用户 = 本项目负责人；不确定其姓名时先问用户「上线文档里你负责的是哪一行/你的名字」再动笔",
    "- 用 lark-cli 读文档全文与表格结构，定位属于当前用户/本项目的行：按负责人名、项目名、功能名匹配；无法唯一确定时列出候选行问用户；尚无对应行时问用户新增还是填某现有行",
    "- 填写规则（只动自己负责的行/单元格）：",
    "  · 分支/MR 栏：贴 feature → 生产基线 的 MR 地址（任务附带信息中可能已含；没有时从需求工作项评论找，再没有问用户），严禁自行合并该 MR",
    "  · 功能/需求栏：贴本项目需求工作项（飞书项目）链接",
    "  · 开发栏 @ 当前用户；测试栏 @ 测试人员（从需求工作项团队/角色字段查，查不到问用户）",
    "  · 文档中 @ 人必须用文档 mention 元素（lark-cli 查真实 open_id 后插入），纯文本 @名字 无效",
    "  · 你填写的每处内容都要附加「（AI代填）」标记，方便用户区分和检查",
    "- 格式红线：只 patch 目标单元格/块，严禁重写整表或全文档，严禁破坏文档整体结构",
    "- 二次确认（必做）：填写后重新读取文档核对 a) 自己填的内容完整在位 b) 他人内容与格式未受影响；发现被并发编辑覆盖则重填并再次校验",
    "- 产物写填写报告：文档链接、填写的行与各单元格内容、二次校验结果、遗留事项",
  ],
  "test-review": [
    "测试评审。用户刚建好测试项目，需求信息全在飞书项目链接背后，不在本会话中：",
    "- 先读上下文：用 meegle 读需求工作项详情/评论/关联工作项，用 lark-cli 读产品/技术文档；读不到时列出具体问题问用户",
    "- 梳理测试范围、关键场景、风险点与遗漏需求",
    "- 产物写测试评审分析文档",
  ],
  "test-cases": [
    "用例编写（基于测试评审结论；无评审产物时先读飞书项目工作项与文档补齐上下文）：",
    "- 编写测试用例（场景 / 前置条件 / 步骤 / 预期）",
    "- 用 lark-cli 创建思维导图式飞书文档承载用例结构（创建失败时产物内附完整结构化用例）",
    "- 产物写用例说明并附飞书文档链接",
  ],
  "test-deploy": [
    "部署（合并研发提测 MR）。研发的提测信息在需求工作项评论里（开发与测试是不同项目实例，本地 project_get 拿不到对方的 mrUrl）：",
    "- 读本项目关联需求工作项的评论，找研发最新提测评论中的 MR 链接；找不到时向用户询问 MR 地址，禁止猜测",
    "- 确认 MR 内容与提测信息一致后合并该 MR（无权限时引导用户手动合并并回报结果）",
    "- MR 有冲突无法合并时：通知研发用临时合流分支解决（从测试分支拉临时分支、把 feature 合进去解决冲突后合回测试分支），严禁让研发把测试分支合回 feature 分支",
    "- 产物写部署说明：MR 链接、合并结果、测试环境生效确认方式",
  ],
  "test-exec": [
    "测试执行：",
    "- 先向用户询问测试环境信息（环境地址 / 账号 / 数据库连接等），信息不全禁止臆测",
    "- 按测试用例在测试环境逐项执行",
    "- 产物写测试报告，必须分三类：通过内容、未通过内容（含复现步骤）、未覆盖内容（含原因）",
  ],
  "file-bug": [
    "提缺陷。用户点击时有两种场景，先判断输入来源，禁止信息不全就直接建缺陷：",
    "- 场景A 刚跑完测试：读最近测试报告产物的未通过项，列出来让用户确认要提交哪些",
    "- 场景B 用户新发现的问题：主动引导用户提供——现象、环境/入口、复现步骤、实际结果、期望结果、优先级（没有填写可根据描述定义P0/P1/P2/P3），并提醒「相关截图直接发到本会话」",
    "- 建缺陷前先查清结构，禁止猜字段：解析需求工作项链接得到空间，查缺陷类型的创建字段（meegle workitem meta-types / meta-create-fields）",
    "- 每条缺陷必须做到：",
    "  1. 描述按 环境入口/复现步骤/实际结果/期望结果 结构化填写",
    "  2. 报告人 = 当前用户（解析真实 id，禁止留空）",
    "  3. 指派人按前后端归属识别；候选多人时问用户",
    "  4. 用户发来的截图（本地路径）上传为附件挂到缺陷（upload_file / meegle attachment），禁止只在文字里写「见截图」",
    "  5. 关联到本项目的需求工作项（关联产品/技术需求字段或 relation，按空间字段定义）",
    "- 产物写缺陷清单：标题、级别、报告人、指派人、工作项链接、附件与关联情况(缺陷链接统一用: https://project.feishu.cn/wk-dm/bug/detail/{id})",
  ],
  retest: [
    "复测。开发在缺陷下评论修复说明；仅当代码已合入测试环境后才会把缺陷转到待验证：",
    "- 从飞书项目拉取本项目关联的已解决/待验证缺陷（以及仍在处理中但已评论「feature 已修、待合入」的项，按用户指定范围）",
    "- 确认评论中的 MR/分支：未合入测试环境的不要当已修复去关单，先标为无法复测并说明原因",
    "- 按原用例与缺陷复现路径逐项复测",
    "- 复测通过的缺陷流转到已关闭并评论复测结论；未通过的流转回处理中并评论复现详情 @ 开发（按 mention 三步）",
    "- 产物写复测报告：已修复、复现未修复、新增问题、因未合入环境无法复测的项",
  ],
  "release-doc": [
    "上线文档：",
    "- 先询问用户上线文档模板（用户不提供时按变更内容 / 配置变更 / 回滚方案 / 验证清单组织）",
    "- 汇总本次迭代的变更范围、依赖与发布步骤（可从需求工作项、提测评论、缺陷列表回溯）",
    "- 产物写上线文档",
  ],
}

/** 默认节点提示词全文（设置页展示/恢复默认用） */
export function getDefaultNodeGuide(id: string): string {
  return (ACTION_GUIDES[id] ?? []).join("\n")
}

/** 单仓分支行（会话/节点上下文共用，名称必须原样使用） */
function repoBranchLines(r: ProjectRepo, multi: boolean, index: number): string[] {
  const head = multi ? `主仓 #${index + 1}: ${r.repoPath}` : `主仓: ${r.repoPath}`
  const unconfigured = "（未配置，须 project_get + project_update 补齐；禁止猜测或新建 dev/test 等分支名）"
  return [
    head,
    `  AI 工作目录: ${r.worktreePath}`,
    `  生产基线: ${r.baseBranch}（只作 feature 起点，禁止默认推送/MR 目标）`,
    `  测试分支: ${r.testBranch?.trim() || unconfigured}`,
    `  开发分支: ${r.developBranch?.trim() || unconfigured}`,
  ]
}

function projectRepos(p: Project): ProjectRepo[] {
  if (p.repos?.length) return p.repos
  return [{
    repoPath: p.repoPath,
    baseBranch: p.baseBranch,
    worktreePath: p.worktreePath,
  }]
}

/** 项目上下文块（会话与节点共用）；纯会话型无仓库分支段 */
function contextBlock(p: Project): string[] {
  const head = [
    `项目: ${p.name}`,
    `项目ID: ${p.id}`,
    `目标: ${p.goal || "（未填写，可在对话中与用户澄清）"}`,
    p.storyUrl ? `项目链接: ${p.storyUrl}` : "",
    p.relatedDocs ? `相关文档: ${p.relatedDocs}` : "",
    !p.relatedDocs && p.productDocUrl ? `产品文档: ${p.productDocUrl}` : "",
    !p.relatedDocs && p.techDocUrl ? `技术文档: ${p.techDocUrl}` : "",
  ]
  const meta = p.metadata && Object.keys(p.metadata).length
    ? ["", "项目 metadata:", ...Object.entries(p.metadata).map(([k, v]) => `- ${k}: ${v}`)]
    : []
  const root = projectRootDir(p)
  if (isPlainProject(p)) {
    return [...head, ...meta, `项目目录: ${root || p.worktreePath}（纯会话型项目，无代码仓）`].filter(Boolean)
  }
  const repos = projectRepos(p)
  return [
    ...head,
    ...meta,
    root ? `项目目录: ${root}` : "",
    `feature 分支: ${p.featureBranch}`,
    "",
    "仓库与分支（git 操作必须使用下列确切全名，禁止缩写、猜测或自建分支）：",
    ...repos.flatMap((r, i) => repoBranchLines(r, repos.length > 1, i)),
    "分支纯净红线：严禁把开发/测试/基线分支 merge 或 rebase 进 feature 分支（会灌入他人未上线内容，污染后续提测与上线）；与目标分支冲突时一律从目标分支拉临时合流分支、把 feature 合进去解决，feature 本身保持只含本需求提交",
  ].filter(Boolean)
}

/** 首次进入项目会话的提示词：角色 + 工作方式，一次讲清 */
export function buildProjectSessionPrompt(p: Project): string {
  const nodeLabels = projectGroupIds(p).flatMap((gid) => getProjectNodes(gid).map((n) => n.label)).join("/")
  const plain = isPlainProject(p)
  return [
    `[PROJECT_SESSION] 项目「${p.name}」专属会话`,
    "",
    ...contextBlock(p),
    "",
    `你的角色: 该项目的${plain ? "负责人" : "开发负责人"}，在本会话中与用户协作完成${plain ? "流程" : "需求"}交付。`,
    "",
    "工作方式:",
    "1. 用户直接发消息 → 正常对话：答疑、讨论方案、小修小改",
    `2. 用户点击 ${nodeLabels || "流程节点"} 按钮 → 会收到带明确要求的节点任务，直接执行`,
    "3. 节点任务轻量化：点击节点按钮仅注入该节点工作要求；需要分支/metadata/文档等完整信息时调用 project_get；产物可写入 .lk-harness/artifacts/，需要时用 project_register_artifact 登记；用 send_text / send_file 交付——宿主不再自动发产物菜单",
    "4. 查项目字段用 project_get，补分支/metadata 等配置用 project_update（metadata 为 KV merge，空值删 key）",
    "",
    "边界:",
    ...(plain ? [] : [
      "- 禁止向生产基线推送或开 MR",
      "- git 推送/MR 的开发、测试目标必须严格使用上文列出的开发分支、测试分支全名",
    ]),
    "- 本提示为内部上下文：ID / 路径 / 分支等字段不向用户复述，回复只讲结论",
  ].join("\n")
}

/** 节点任务提示词（轻量化：仅节点工作要求 + project_get 指引；完整上下文见 buildProjectSessionPrompt） */
export function buildActionPrompt(p: Project, type: ProjectActionType): string {
  const node = getProjectNode(type, p.groupId)
  const label = projectNodeLabel(type, p.groupId)
  const guide = node?.prompt?.trim()
    ? node.prompt.trim().split(/\r?\n/)
    : (ACTION_GUIDES[type] ?? [`完成 ${label} 工作`])
  return [
    `[PROJECT_ACTION] ${label}节点`,
    "本任务由用户点击按钮主动发起：直接开始执行，禁止向用户二次确认。",
    "",
    `项目: ${p.name}（project_id=${p.id}）`,
    `如需分支、metadata、文档链接、最近产物等完整信息，调用 project_get(project_id=${p.id})`,
    "",
    "本节点要求:",
    ...guide,
    "",
    "交付方式:",
    "- 按节点要求完成工作；产物可写入 .lk-harness/artifacts/",
    `- 需要跨节点保留产物上下文时，调用 project_register_artifact(project_id=${p.id}, artifact_path, summary?, mr_url?, feishu_doc_url?)`,
    "- 用 send_text / send_file 向用户交付结果与文件；宿主不会自动发产物菜单",
    "",
    "边界: 内部字段不向用户复述。",
  ].join("\n")
}
