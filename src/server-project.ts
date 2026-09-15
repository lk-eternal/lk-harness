import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import { z } from "zod"

import {

  getProject,

  getCurrentProject,

  getProjectNodes,

  projectGroupIds,

  registerArtifact,

  mergeProjectMetadata,

} from "./shared/project-store.js"

import { projectIdFromSessionKey } from "./shared/project-types.js"

import { buildNodeActionPrompt } from "./shared/project-node-guides.js"



function txt(text: string) {

  return { content: [{ type: "text" as const, text }] }

}



export function registerProjectAgentTools(mcpServer: McpServer): void {

  mcpServer.tool(

    "project_register_artifact",

    "登记项目最近产物（供后续节点注入上下文）。仅写元数据，不发消息、不推菜单；交付用户请用 send_file",

    {

      project_id: z.string().describe("项目 ID"),

      artifact_path: z.string().describe("产物相对或绝对路径"),

      summary: z.string().optional(),

      mr_url: z.string().optional(),

      feishu_doc_url: z.string().optional(),

    },

    async (args) => {

      const r = registerArtifact(args.project_id, {

        artifactPath: args.artifact_path,

        summary: args.summary,

        mrUrl: args.mr_url,

        feishuDocUrl: args.feishu_doc_url,

      })

      if (!r.ok) return txt(`❌ ${r.error}`)

      return txt(`✅ 已登记产物 ${args.artifact_path}`)

    },

  )



  mcpServer.tool(

    "project_update",

    "更新项目元数据。字段红线：baseBranch=生产基线，只作切 feature 起点，禁止默认作为 ship 推送/MR 目标；testBranch=测试环境；developBranch=开发环境。可补齐 repos[].testBranch/developBranch、goal、文档链接、metadata（KV merge，空值删 key）等。",

    {

      project_id: z.string().optional().describe("项目 ID；缺省当前项目"),

      session_key: z.string().optional(),

      goal: z.string().optional(),

      story_url: z.string().optional(),

      product_doc_url: z.string().optional(),

      tech_doc_url: z.string().optional(),

      feature_branch: z.string().optional(),

      base_branch: z.string().optional().describe("生产基线（谨慎修改）"),

      test_branch: z.string().optional().describe("主仓测试分支"),

      develop_branch: z.string().optional().describe("主仓开发分支"),

      repo_index: z.number().int().min(0).optional().describe("改第几个仓的分支，默认 0"),

      metadata: z.record(z.string(), z.string()).optional().describe("项目 KV 配置 merge 写入；value 传空字符串删 key"),

    },

    async (args) => {

      let id = args.project_id

      if (!id && args.session_key) id = projectIdFromSessionKey(args.session_key)

      const p = id ? getProject(id) : getCurrentProject()

      if (!p) return txt("❌ 未找到项目")

      if (args.goal !== undefined) p.goal = args.goal

      if (args.story_url !== undefined) p.storyUrl = args.story_url || undefined

      if (args.product_doc_url !== undefined) p.productDocUrl = args.product_doc_url || undefined

      if (args.tech_doc_url !== undefined) p.techDocUrl = args.tech_doc_url || undefined

      if (args.feature_branch !== undefined) p.featureBranch = args.feature_branch

      if (args.base_branch !== undefined) {

        p.baseBranch = args.base_branch

      }

      const repos = [...(p.repos || [{

        repoPath: p.repoPath,

        baseBranch: p.baseBranch,

        worktreePath: p.worktreePath,

      }])]

      const idx = args.repo_index ?? 0

      if (!repos[idx]) return txt(`❌ repos[${idx}] 不存在`)

      if (args.base_branch !== undefined) repos[idx].baseBranch = args.base_branch

      if (args.test_branch !== undefined) repos[idx].testBranch = args.test_branch || undefined

      if (args.develop_branch !== undefined) repos[idx].developBranch = args.develop_branch || undefined

      p.repos = repos

      if (args.metadata) mergeProjectMetadata(p, args.metadata)

      if (idx === 0) {

        p.repoPath = repos[0].repoPath

        p.baseBranch = repos[0].baseBranch

        p.worktreePath = repos[0].worktreePath

      }

      const { saveProject } = await import("./shared/project-store.js")

      saveProject(p)

      process.stdout.write(`__PROJECT_PROFILE_UPSERT__:${JSON.stringify({

        path: repos[idx].repoPath,

        baseBranch: repos[idx].baseBranch,

        testBranch: repos[idx].testBranch,

        developBranch: repos[idx].developBranch,

      })}\n`)

      return txt(`✅ 已更新项目 ${p.id}\n${JSON.stringify({

        goal: p.goal,

        featureBranch: p.featureBranch,

        baseBranch: p.baseBranch,

        repos: p.repos,

        metadata: p.metadata,

      }, null, 2)}`)

    },

  )



  mcpServer.tool(

    "project_get",

    "查询项目详情（含 lastArtifact* 等元数据）",

    {

      project_id: z.string().optional().describe("项目 ID；缺省当前项目；也可从 session 推断"),

      session_key: z.string().optional(),

    },

    async ({ project_id, session_key }) => {

      let id = project_id

      if (!id && session_key) id = projectIdFromSessionKey(session_key)

      const p = id ? getProject(id) : getCurrentProject()

      if (!p) return txt("❌ 未找到项目")

      return txt(JSON.stringify(p, null, 2))

    },

  )

  mcpServer.tool(

    "project_get_node",

    "查询单节点完整要求（含自定义 prompt 回退，与按钮点击注入同源；自然语言命中节点后必须先调本口再干活）",

    {

      project_id: z.string().optional().describe("项目 ID；缺省当前项目；也可从 session 推断"),

      node_id: z.string().describe("节点 id（会话可用节点索引中的 id，原样使用）"),

      session_key: z.string().optional(),

    },

    async ({ project_id, node_id, session_key }) => {

      let id = project_id

      if (!id && session_key) id = projectIdFromSessionKey(session_key)

      const p = id ? getProject(id) : getCurrentProject()

      if (!p) return txt("❌ 未找到项目")

      const available = projectGroupIds(p).flatMap((gid) => getProjectNodes(gid).map((n) => n.id))

      if (!available.includes(node_id)) return txt(`❌ 项目「${p.name}」无此节点：${node_id}\n可用节点：${available.join("、") || "（暂无）"}`)

      return txt(buildNodeActionPrompt(p, node_id, `自然语言命中 id=${node_id} 已取全文`))

    },

  )

}


