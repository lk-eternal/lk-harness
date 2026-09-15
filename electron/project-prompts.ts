import { isPlainProject, projectRootDir, type Project, type ProjectActionType, type ProjectRepo } from "../src/shared/project-types.js"
import { getProjectNodes, projectGroupIds } from "../src/shared/project-store.js"
import { buildNodeActionPrompt } from "../src/shared/project-node-guides.js"

// 设置页/同步服务仍从此处取默认模板（真值在 shared/project-node-guides.ts，两侧同源）
export { ACTION_GUIDES, getDefaultNodeGuide } from "../src/shared/project-node-guides.js"

// ════════════════════════════════════════════════════════════
// 项目工作流提示词模板（改文案只动本文件下半部分；节点全文真值见 shared/project-node-guides.ts）
// ════════════════════════════════════════════════════════════

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

/** 首次进入项目会话的提示词：角色 + 工作方式 + 节点索引（仅 id+label，不编触发词） */
export function buildProjectSessionPrompt(p: Project): string {
  const nodeIndex = projectGroupIds(p).flatMap((gid) => getProjectNodes(gid).map((n) => `- ${n.id}（${n.label}）`))
  const plain = isPlainProject(p)
  return [
    `[PROJECT_SESSION] 项目「${p.name}」专属会话`,
    "",
    ...contextBlock(p),
    "",
    `你的角色: 该项目的${plain ? "负责人" : "开发负责人"}，在本会话中与用户协作完成${plain ? "流程" : "需求"}交付。`,
    "",
    "工作方式:",
    "1. 普通对话：用户直接发消息、问答讨论、小修小改 → 直接回。",
    "2. 按钮任务：用户点击按钮会收到 [PROJECT_ACTION] 任务 → 按任务要求执行（信息齐备直接执行，缺关键输入先问清再干）。",
    "3. 自然语言节点意图：用户没点按钮、但话里是某个节点的事 → 按节点发现协议处理，不凭记忆直接干。",
    "",
    "可用节点（id 为唯一标识，label 仅展示用）：",
    ...(nodeIndex.length ? nodeIndex : ["（暂无节点）"]),
    "",
    "节点发现协议:",
    `- 命中：意图明确匹配某节点 → 必须先调 project_get_node(project_id=${p.id}, node_id=[命中id]) 拿该节点完整要求，再按要求执行，视同按钮任务；禁止跳过取全文直接干。`,
    "- 消歧：意图模糊或沾多个节点 → 先查状态（project_get / 飞书工作项），再问用户确认目标节点，不直接开干。",
    "- 非节点闲聊不触发本协议。",
    "",
    "查数与写数（全会话唯一指引）:",
    `- 查：project_get(project_id=${p.id}) 查分支/metadata/文档链接/最近产物；project_get_node 查单节点全文。内部 ID/路径/分支不向用户复述。`,
    "- 写：补分支/metadata 用 project_update（metadata 为 KV merge，空值删 key）；需跨节点保留产物上下文时用 project_register_artifact(project_id="
      + `${p.id}, artifact_path, summary?, mr_url?, feishu_doc_url?)。`,
    "- 产物文件写 AI 工作目录下的 .lk-harness/artifacts/（多仓项目写主仓对应目录），用 send_file 交付文件。",
    "",
    "边界:",
    ...(plain ? [] : [
      "- 禁止向生产基线推送或开 MR",
      "- git 推送/MR 的开发、测试目标必须严格使用上文列出的开发分支、测试分支全名",
    ]),
  ].join("\n")
}

/** 节点任务提示词（按钮入口；与 project_get_node 同源，见 shared/project-node-guides.ts） */
export function buildActionPrompt(p: Project, type: ProjectActionType, origin = "按钮点击直接下发"): string {
  return buildNodeActionPrompt(p, type, origin)
}
