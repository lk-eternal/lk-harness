import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import { z } from "zod"

import {

  getProject,

  getCurrentProject,

  projectNodes,

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

    "登记项目最近产物/成果（供后续步骤注入上下文）。仅写元数据，不发消息、不推菜单；交付用户请用 send_file。mr_url / feishu_doc_url 只有研发项目才用，其他项目不用传",

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

    "更新项目信息。通用：goal（项目目标）、story_url（项目链接）、metadata（KV merge，空值删 key；记录对象、截止时间、偏好、代码仓库和分支等之后会话还要用的信息）。",

    {

      project_id: z.string().optional().describe("项目 ID；缺省当前项目"),

      session_key: z.string().optional(),

      goal: z.string().optional(),

      story_url: z.string().optional(),

      product_doc_url: z.string().optional(),

      tech_doc_url: z.string().optional(),

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

      if (args.metadata) mergeProjectMetadata(p, args.metadata)

      const { saveProject } = await import("./shared/project-store.js")

      saveProject(p)

      return txt(`✅ 已更新项目 ${p.id}\n${JSON.stringify({ goal: p.goal, storyUrl: p.storyUrl, metadata: p.metadata }, null, 2)}`)

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

      const available = projectNodes(p).map((n) => n.id)

      if (!available.includes(node_id)) return txt(`❌ 项目「${p.name}」无此节点：${node_id}\n可用节点：${available.join("、") || "（暂无）"}`)

      return txt(buildNodeActionPrompt(p, node_id, `自然语言命中 id=${node_id} 已取全文`))

    },

  )

}


