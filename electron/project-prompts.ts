import { projectRootDir, type Project, type ProjectActionType } from "../src/shared/project-types.js"
import { buildNodeActionPrompt } from "../src/shared/project-node-guides.js"
import { projectHasRepoInfo } from "../src/shared/project-repo-info.js"
import { resolveGitPrinciples } from "../src/shared/project-git-principles.js"

// 设置页/同步服务仍从此处取默认模板（真值在 shared/project-node-guides.ts，两侧同源）
export { ACTION_GUIDES, getDefaultNodeGuide } from "../src/shared/project-node-guides.js"

// ════════════════════════════════════════════════════════════
// 项目工作流提示词模板（改文案只动本文件；节点全文真值见 shared/project-node-guides.ts）
// 只告诉 AI 必要的项目信息：名称、目标、链接、项目信息（含代码仓库和分支，和别的信息一样只是几行字）、目录。
// 流程怎么走、分支怎么用，由用户在模板的步骤提示词里和设置的「Git 基本原则」里自己定。
// ════════════════════════════════════════════════════════════

/** 项目上下文块（会话与节点共用） */
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
    ? ["", "项目信息:", ...Object.entries(p.metadata).map(([k, v]) => `- ${k}: ${v}`)]
    : []
  const root = projectRootDir(p) || p.worktreePath
  return [...head, ...meta, root ? `项目目录: ${root}` : ""].filter(Boolean)
}

export interface ProjectSessionPromptOpts {
  /** 设置里存的「Git 基本原则」（原样传，不要自己套默认值）：没设过=用默认，清空=不带 */
  gitPrinciples?: string | null
}

/** 首次进入项目会话的提示词：项目上下文 + 工作方式（节点索引/发现协议见每轮 [本轮投递] node_protocol） */
export function buildProjectSessionPrompt(p: Project, opts?: ProjectSessionPromptOpts): string {
  const hasRepo = projectHasRepoInfo(p)
  const principles = hasRepo ? resolveGitPrinciples(opts?.gitPrinciples) : ""
  return [
    `[PROJECT_SESSION] 项目「${p.name}」专属会话`,
    "",
    ...contextBlock(p),
    ...(principles ? ["", principles] : []),
    "",
    "工作方式:",
    "1. 普通对话：用户直接发消息、问答讨论、小修小改 → 直接回。",
    "2. 按钮任务：用户点击按钮会收到 [PROJECT_ACTION] 任务 → 按任务要求执行（信息齐备直接执行，缺关键输入先问清再干）。",
    "3. 自然语言：按每轮 [本轮投递] 内 node_protocol 判断是否拉取节点提示词。",
    "",
    "查数与写数（全会话唯一指引）:",
    `- 查：project_get(project_id=${p.id}) 查项目信息/链接/最近成果；project_get_node 查单步骤全文。内部 ID/路径不向用户复述。`,
    `- 写：了解到新的项目信息（对象、截止时间、偏好${hasRepo ? "、仓库和分支" : ""}等）用 project_update 记进 metadata（KV merge，空值删 key），之后的会话都能看到；需跨步骤保留成果时用 project_register_artifact(project_id=${p.id}, artifact_path, summary?${hasRepo ? ", mr_url?, feishu_doc_url?" : ""})。`,
    "- 成果文件写当前目录下的 .lk-harness/artifacts/，用 send_file 交付文件。"
      + (p.externalWorkspace ? "项目目录里用户放的资料都可以读，但不要改动或删除用户原有文件，除非用户明确要求。" : ""),
  ].join("\n")
}

/** 节点任务提示词（按钮入口；与 project_get_node 同源，见 shared/project-node-guides.ts） */
export function buildActionPrompt(
  p: Project,
  type: ProjectActionType,
  origin = "按钮点击直接下发",
  opts?: ProjectSessionPromptOpts,
): string {
  // 设置里把 Git 基本原则清空了：节点开头也别再提它
  const gitReminder = resolveGitPrinciples(opts?.gitPrinciples) !== ""
  return buildNodeActionPrompt(p, type, origin, { gitReminder })
}
