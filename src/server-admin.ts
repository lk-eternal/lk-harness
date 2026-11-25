import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { LOCK_FILE_NAME } from "./shared/constants.js";
import { parseChatKey, chatIdFromSessionKey } from "./shared/channel-types.js";
import { getMcpInvokerSessionKey } from "./shared/mcp-invoker-context.js";
import { listProjects, listProjectsForChannel, getProject } from "./shared/project-store.js";
import type { Project } from "./shared/project-types.js";
import { concatUtf8 } from "./shared/utf8-stream.js";
import { getHostRpc, type HostRpc } from "./shared/host-rpc.js";
import { formatBound, formatChannels, formatCreated, formatRepos, formatTemplates, formatUnbound, parseAiBindings } from "./shared/project-ai-format.js";
import { formatSetupChecklist } from "./shared/project-admin-format.js";
import { buildProjectHelp, PROJECT_HELP_TOPICS } from "./shared/project-ai-help.js";
import type { AdminOutcome, SettingsOutcome } from "./shared/project-admin-plan.js";
import type {
  AiProjectChannelsResult,
  AiProjectCreateResult,
  ProjectBindResult,
  ProjectRepoOption,
  ProjectTemplateInfo,
  ProjectUnbindResult,
} from "./shared/project-app-types.js";

const APP_DATA_DIR = process.env.APP_DATA_DIR ?? "";

function getDaemonPort(): number {
  if (APP_DATA_DIR) {
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(APP_DATA_DIR, LOCK_FILE_NAME), "utf-8"));
      if (lock.port) return Number(lock.port);
    } catch { /* fall through to env */ }
  }
  return process.env.LARK_DAEMON_PORT ? Number(process.env.LARK_DAEMON_PORT) : 0;
}

function daemonUrl(path: string): string {
  return `http://127.0.0.1:${getDaemonPort()}${path}`;
}

function txt(text: string) { return { content: [{ type: "text" as const, text }] }; }

function indentLines(text: string, prefix: string): string {
  return text.split("\n").map((l) => prefix + l).join("\n");
}

async function daemonGet(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get(daemonUrl(path), { timeout: 10_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(concatUtf8(chunks))); } catch { reject(new Error("invalid json")); }
      });
    }).on("error", reject);
  });
}

async function daemonPost(path: string, body: unknown): Promise<any> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(daemonUrl(path), { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }, timeout: 10_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(concatUtf8(chunks))); } catch { reject(new Error("invalid json")); }
      });
    });
    req.on("error", reject);
    req.end(data);
  });
}

export interface AdminToolDeps {
  /** 请宿主（Electron 主进程）做事的通道；测试里换成假的 */
  hostRpc?: HostRpc;
}

/** 读模板 / 常用仓库：宿主只是读配置，几秒内一定有结果 */
const HOST_QUICK_TIMEOUT_MS = 15_000;
/** 登记仓库要用 git 看一眼它是不是仓库、有哪些分支，本地大仓库也要几秒 */
const HOST_ADMIN_TIMEOUT_MS = 60_000;
/** 建项要建目录、按设置克隆仓库（大仓库、远程仓库可能很慢），给足时间 */
const HOST_CREATE_TIMEOUT_MS = 10 * 60_000;

export function registerAdminTools(mcpServer: McpServer, deps: AdminToolDeps = {}): void {
  const hostRpc = (): HostRpc => deps.hostRpc ?? getHostRpc();

  // ── manage_agent ──

  mcpServer.tool(
    "manage_agent",
    "管理应用自身。支持查询状态、停止Agent、重启应用、重置会话、清空队列、启动临时会话。",
    {
      action: z.enum(["status", "stop", "restart", "reset", "clean", "launch"]).describe("status=查询状态; stop=停止Agent; restart=重启应用; reset=重置会话; clean=清空队列; launch=新建临时工作目录会话并入队首条消息"),
      message: z.string().optional().describe("launch 时必填：首轮交给 Agent 的任务说明"),
    },
    async ({ action, message }) => {
      try {
        if (action === "status") {
          const data = await daemonGet("/api/status");
          const d = data.daemon ?? {};
          const q = data.queue ?? {};
          const t = data.tasks ?? {};
          const lines = [
            `🛡️ Daemon: 运行中 (v${d.version}, ${Math.floor((d.uptime ?? 0) / 60)}分钟)`,
            `🤖 Agent: ${d.agentRunning ? "运行中" : "未运行"}${d.sessionAgentCount > 0 ? ` (${d.sessionAgentCount} 个会话)` : ""}`,
            `📭 队列消息: ${q.length ?? 0} 条`,
            `⏰ 定时任务: 启用 ${t.enabled ?? 0} / 共 ${t.total ?? 0}`,
          ];
          return txt(lines.join("\n"));
        }
        if (action === "launch") {
          if (!message?.trim()) return txt("❌ launch 操作需要提供 message 参数");
          const invokerSessionKey = getMcpInvokerSessionKey();
          const chatId = invokerSessionKey ? chatIdFromSessionKey(invokerSessionKey) : undefined;
          if (!chatId?.includes("|")) {
            return txt("❌ launch 须在飞书/微信聊天 Agent 上下文中调用");
          }
          const channelId = parseChatKey(chatId).channelId;
          const res = await daemonPost("/api/agent", {
            action: "launch", message, chatId, channelId, invokerSessionKey,
          });
          if (!res.ok) return txt(`❌ ${res.error ?? "启动失败"}`);
          return txt(`✅ 已切换临时目录会话\n📂 ${res.workspaceDir ?? ""}\n🔑 ${res.sessionKey ?? ""}`);
        }
        const res = await daemonPost("/api/agent", { action });
        return txt(res.ok ? `✅ /${action} 已执行` : `❌ ${res.error ?? "操作失败"}`);
      } catch (e: any) {
        return txt(`❌ Daemon 通信失败: ${e?.message ?? e}`);
      }
    },
  );

  // ── manage_mcp ──

  mcpServer.tool(
    "manage_mcp",
    "管理 LK Harness Agent 挂载的 MCP 服务器。",
    {
      action: z.enum(["list", "add", "delete"]).describe("list=列出; add=添加或更新; delete=删除"),
      name: z.string().optional().describe("MCP 名称（add/delete 必填；内置 lk-harness* 不可覆盖）"),
      config: z.string().optional().describe("add 必填：MCP 配置 JSON，如 command/args 或 url"),
    },
    async ({ action, name, config }) => {
      try {
        if (action === "list") {
          const data = await daemonGet("/api/mcp");
          const servers = data.servers ?? {};
          if (Object.keys(servers).length === 0) return txt("当前没有配置任何 MCP 服务器。");
          const lines = Object.entries(servers).map(([k, v]: [string, any]) => `- **${k}**: ${JSON.stringify(v.config)}`);
          return txt(lines.join("\n"));
        }
        if (!name) return txt("错误：name 参数必填");
        const res = await daemonPost("/api/mcp", { action, name, config });
        return txt(res.ok ? `✅ ${res.message}` : `❌ ${res.error ?? "操作失败"}`);
      } catch (e: any) {
        return txt(`❌ Daemon 通信失败: ${e?.message ?? e}`);
      }
    },
  );

  // ── manage_project ──
  mcpServer.tool(
    "manage_project",
    [
      "管理项目，以及项目相关的全部配置：创建、查看、修改、归档、删除项目；常用代码仓库、项目模板、项目存放位置、Git 基本原则、GitLab 的查看和修改。用户用自然语言说要建项目、配仓库、改模板时由你替他办，不要让他去设置页翻。",
      "- help：【先读它】项目功能的完整操作手册：概念、建项目的完整流程、怎么引导新手用户、各项配置怎么做（topic 可选 create / repos / templates / settings / manage 看细节）。用户提到项目、仓库、模板、GitLab、配置，或你拿不准怎么做时，先 help；不带 topic 的 help 还会列出当前配了什么、还缺什么。",
      "- list：列出你所在消息通道下的项目（含 ID）；get：看一个项目的完整资料，含它接入了哪些聊天（project_id）。项目按消息通道隔离：只有接入了某个通道的项目，那个通道里的人和 AI 才看得到、管得了。",
      "- channels：看你现在在哪个消息通道，以及能把项目接到哪些通道、各自能用什么方式（主聊天 / 新建飞书群 / 绑定已有群）。建项目前先调它，再问用户项目要放到哪。",
      "- templates：列出项目模板：每个模板的 ID、要填的信息（哪些必填）、接不接代码仓库、默认工作分支；给 template_id 看一个模板的完整内容，再给 action_id 看某个快捷操作的提示词全文。",
      "- repos：列出常用代码仓库（路径、基线分支、测试 / 开发分支、是否克隆）。",
      "- create：创建项目。用户让你建项目、又不想自己填表时用。流程：先 templates 看模板和必填项（要接代码再 repos），把用户的话整理成参数；信息不够就问用户，不要猜；创建前把整理好的内容（名称、模板、各项信息、仓库和分支、文件夹）发给用户确认（send_question），确认后才调用。会建项目目录、按设置克隆仓库，可能要一会儿。建完不会进入项目会话（当前对话不受影响）。必须指定 bindings（项目接入哪些通道、用什么方式），没有默认值：先用 channels 看有哪些通道和各自能用的方式，用户没说清楚就问他（send_question），确认内容里要写明每个通道选了什么。bindings 每项是 {channel_id, mode, group_chat_id?}：mode=inline 接该通道的主聊天（不建群）；group 新建飞书独立群并把用户拉入群；bind 绑定已有的飞书群（还要给 group_chat_id）；一个项目可以同时接多个通道，每个通道各自一条独立会话。飞书 / 微信里的调用者只能接自己所在的通道，应用内对话里可以接任何通道。建完把每个通道的结果如实告诉用户（失败的原因要说）：inline 项目他需要时自己进入，群里的项目到群里协作。",
      "- bind：给已有项目补接入（project_id + bindings，写法同 create）；unbind：取消项目在某个通道上的接入（project_id + bindings 里放一项 {channel_id, mode, group_chat_id?}：inline=主聊天，group / bind=专属群）。项目至少要留一个接入。取消会把那条会话一并清掉，先向用户确认。",
      "- update：改项目资料（project_id；只给要改的：name / goal / story_url / related_docs / fields=项目信息键值，空字符串删掉该项）。archive：归档 / 取消归档（project_id + archived）。",
      "- repo_save：登记或修改常用代码仓库（repo={repo_path, base_branch?, test_branch?, develop_branch?, clone?}）；repo_remove：移除（repo={repo_path}）。",
      "- template_save：新建（不给 template_id）或修改项目模板（template；改动立即对所有在用它的项目生效）；template_delete：删除模板（template_id）。新建 / 修改前先 help topic=templates。",
      "- settings：看项目设置现状（项目存放位置、Git 基本原则、GitLab、共享空间；密钥只显示打码）；settings_set：修改（settings；只给要改的）。用户发来的 Token 直接写入，回复里不要重复原文。",
      "- delete：删除项目（宿主连带移除项目目录；不动用户自己的代码仓库与远程分支，删除前必须先向用户确认）。",
    ].join("\n"),
    {
      action: z.enum([
        "help", "list", "get", "create", "update", "archive", "delete", "channels", "bind", "unbind",
        "templates", "template_save", "template_delete", "repos", "repo_save", "repo_remove", "settings", "settings_set",
      ]).describe("操作：help=操作手册（先读）, list=列出你所在通道的项目, get=项目详情, channels=看当前通道和可接入的通道, create=创建项目, bind=给项目补接入, unbind=取消接入, update=改项目资料, archive=归档/取消归档, delete=删除项目, templates=查看模板, template_save=新建/修改模板, template_delete=删除模板, repos=列出常用仓库, repo_save=登记/修改仓库, repo_remove=移除仓库, settings=查看项目设置, settings_set=修改项目设置"),
      topic: z.enum(PROJECT_HELP_TOPICS).optional().describe("help 时可选：不给=总览（含建项目完整流程和当前状态）；create / repos / templates / settings / manage=各块细节"),
      project_id: z.string().optional().describe("项目 ID（get / update / archive / bind / unbind / delete 时必填）"),
      archived: z.boolean().optional().describe("archive 必填：true=归档, false=取消归档"),
      name: z.string().optional().describe("项目名称（create 必填；update 时是新名称）"),
      goal: z.string().optional().describe("项目目标，一两句话（create 可选；update 时是新目标）"),
      template_id: z.string().optional().describe("模板 ID（create 必填；template_save 修改时、template_delete、templates 看详情时用；先用 templates 查）"),
      action_id: z.string().optional().describe("templates 带 template_id 时可选：看这个快捷操作的提示词全文"),
      fields: z.record(z.string(), z.string()).optional().describe("create：模板要填的信息，键是字段名，值是内容（必填项必须给，字段名以 templates 返回的为准）；update：项目信息键值，合并写入，值为空字符串=删掉这一项"),
      repo: z.object({
        repo_path: z.string().describe("本地 git 仓库根目录（绝对路径）或远程仓库地址"),
        base_branch: z.string().optional().describe("基线分支（新分支从哪切出）；本地仓库不给会用它的默认分支，远程仓库必须给；已登记的不给=不变"),
        test_branch: z.string().optional().describe("测试分支，可选；空字符串=清掉"),
        develop_branch: z.string().optional().describe("开发分支，可选；空字符串=清掉"),
        clone: z.boolean().optional().describe("建项时是否克隆一份副本到项目目录（默认 true，推荐）；false=不克隆，AI 直接用用户本机这份；远程地址一定克隆"),
      }).optional().describe("repo_save / repo_remove 用"),
      template: z.object({
        name: z.string().optional().describe("模板名称（新建必填；≤30 字，不能和别的模板重名）"),
        description: z.string().optional().describe("一句话说明适合干什么（≤200 字）"),
        needs_repo: z.boolean().optional().describe("接不接代码仓库（写代码、测试类 true；新建默认 false）"),
        work_branch: z.enum(["new", "base", "test", "develop"]).optional().describe("needs_repo=true 时，克隆副本停在哪个分支的默认值"),
        fields: z.array(z.object({
          label: z.string().describe("信息名称"),
          placeholder: z.string().optional().describe("填写示例"),
          required: z.boolean().optional(),
          multiline: z.boolean().optional(),
        })).optional().describe("建项时要用户填的信息（最多 8 项）；给了就是完整新列表"),
        actions: z.array(z.object({
          id: z.string().optional().describe("已有操作带它（保留原提示词）；新增的不用给"),
          label: z.string().describe("快捷操作名称，≤40 字，同一模板里不重名"),
          prompt: z.string().optional().describe("点它时交给 AI 的工作要求；已有操作不给=不变；新增的必须给"),
        })).optional().describe("快捷操作（至少 1 个）；给了就是完整新列表，没列出的已有操作会被删掉"),
      }).optional().describe("template_save 用：新建时 name 必填，修改时只给要改的项"),
      settings: z.object({
        worktree_root: z.string().optional().describe("项目存放位置（绝对路径，不存在会创建）；空字符串=改回默认位置"),
        git_principles: z.string().optional().describe("Git 基本原则全文（≤4000 字）；空字符串=关闭"),
        reset_git_principles: z.boolean().optional().describe("true=恢复默认的 Git 基本原则（不要和 git_principles 一起给）"),
        gitlab_host: z.string().optional().describe("GitLab 地址，只写域名部分，如 https://gitlab.example.com；空字符串=清空"),
        gitlab_token: z.string().optional().describe("GitLab Token；空字符串=清除。不要在回复里重复它"),
        flow_hub_url: z.string().optional().describe("共享空间（团队共用的模板仓库）地址；空字符串=清空"),
        flow_hub_token: z.string().optional().describe("共享空间 Token；空字符串=清除（改用 GitLab Token）。不要在回复里重复它"),
        flow_hub_author: z.string().optional().describe("共享空间里显示的署名"),
      }).optional().describe("settings_set 用：只给要改的项"),
      repos: z.array(z.object({
        repo_path: z.string().describe("本地 git 仓库的根目录（绝对路径）或远程仓库地址"),
        base_branch: z.string().describe("基线分支，必填（常用仓库用 repos 里列出的那个）"),
      })).optional().describe("要接入的代码仓库（create；只有接代码仓库的模板才有效，可以一个都不选）"),
      work_branch: z.enum(["new", "base", "test", "develop"]).optional().describe("克隆副本停在哪个分支（create；不给就用模板默认）：new=新建分支, base=基线分支, test=测试分支, develop=开发分支"),
      feature_branch: z.string().optional().describe("work_branch 是 new 时的分支名；不填自动生成"),
      story_url: z.string().optional().describe("项目链接：需求、任务单等入口（create 可选）"),
      related_docs: z.string().optional().describe("相关文档，链接或说明（create 可选）"),
      folder: z.string().optional().describe("用一个已有文件夹当项目目录，绝对路径（create；只有不接代码仓库的模板可用，应用不会改动里面的文件）"),
      bindings: z.array(z.object({
        channel_id: z.string().describe("消息通道 ID（用 channels 查看）"),
        mode: z.enum(["inline", "group", "bind"]).describe("inline=接该通道的主聊天（不建群）, group=新建飞书独立群并拉用户入群, bind=绑定已有飞书群（要给 group_chat_id）；unbind 时 inline=主聊天，group / bind=专属群"),
        group_chat_id: z.string().optional().describe("mode=bind 时必填（oc_ 开头，机器人要已经在群里）；unbind 专属群时，通道上有多个群才需要"),
      })).optional().describe("项目接入的通道和方式（create / bind 必填，没有默认值，拿不准就问用户；unbind 放一项）：先用 channels 看有哪些通道、各自能用什么方式。飞书 / 微信里只能接自己所在的通道，应用内对话里可以接任何通道"),
    },
    async ({ action, topic, project_id, archived, name, goal, template_id, action_id, fields, repo, template, settings, repos, work_branch, feature_branch, story_url, related_docs, folder, bindings }) => {
      /** 把请求交给宿主，原样返回它给 AI 看的文字（宿主不在、超时、校验没过都带原因） */
      const callAdmin = async (kind: string, payload: unknown, timeoutMs = HOST_QUICK_TIMEOUT_MS): Promise<string> => {
        const out = await hostRpc().request<AdminOutcome>(kind, payload, timeoutMs);
        if (!out.ok) return `❌ ${out.error}`;
        const r = out.result;
        if (!r) return "❌ 应用主进程没有返回结果";
        return r.ok ? r.message : `❌ ${r.error}`;
      };
      /** 调用者所在的聊天（认不出，比如不是在聊天里调的，就是 undefined） */
      const invokerChat = (): string | undefined => {
        const k = getMcpInvokerSessionKey();
        return k ? chatIdFromSessionKey(k) : undefined;
      };
      /** 调用者能管的项目：只有接入了它所在通道的（主聊天或专属群）；不是在聊天里调的（没有调用者）不设限 */
      const visibleProjects = (): Project[] => {
        const chat = invokerChat();
        return chat ? listProjectsForChannel(parseChatKey(chat).channelId) : listProjects();
      };
      const needProject = (): string | undefined => {
        const id = project_id?.trim();
        if (!id) return "❌ 需要 project_id（用 list 查看）";
        if (!visibleProjects().some((p) => p.id === id)) return "❌ 未找到项目（用 list 查看；只能管接入了当前消息通道的项目）";
        return undefined;
      };

      if (action === "help") {
        const h = buildProjectHelp(topic);
        if (!h.ok) return txt(`❌ ${h.error}`);
        let text = h.text;
        // 总览末尾附上当前配了什么、还缺什么；宿主没响应也不耽误看手册
        if (!topic || topic === "overview") {
          const st = await hostRpc().request<SettingsOutcome>("project.settings.get", {}, HOST_QUICK_TIMEOUT_MS);
          if (st.ok && st.result?.ok) text += `\n\n${formatSetupChecklist(st.result.view)}`;
        }
        return txt(text);
      }
      if (action === "list") {
        const list = visibleProjects()
        if (list.length === 0) return txt("📭 当前消息通道下暂无项目")
        const lines = list.map((p, i) => `#${i + 1} ${p.name}${p.archivedAt ? "（已归档）" : ""} id=${p.id}`)
        return txt(lines.join("\n"))
      }
      if (action === "get") return txt(needProject() ?? await callAdmin("project.get", { projectId: project_id }));
      if (action === "update") {
        const missing = needProject();
        if (missing) return txt(missing);
        return txt(await callAdmin("project.update", {
          projectId: project_id,
          update: { name, goal, storyUrl: story_url, relatedDocs: related_docs, info: fields },
        }));
      }
      if (action === "archive") {
        const missing = needProject();
        if (missing) return txt(missing);
        if (archived === undefined) return txt("❌ archive 需要 archived：true=归档，false=取消归档");
        return txt(await callAdmin("project.archive", { projectId: project_id, archived }));
      }
      if (action === "channels" || action === "bind" || action === "unbind") {
        const invoker = getMcpInvokerSessionKey();
        if (!invoker) return txt("❌ 无法确定你所在的会话，不能查看或修改项目接入的通道");
        const chatKey = chatIdFromSessionKey(invoker);
        if (action === "channels") {
          const out = await hostRpc().request<AiProjectChannelsResult>("project.channels", { chatKey }, HOST_QUICK_TIMEOUT_MS);
          if (!out.ok) return txt(`❌ ${out.error}`);
          if (!out.result) return txt("❌ 应用主进程没有返回结果");
          return txt(out.result.ok ? formatChannels(out.result.current, out.result.channels) : `❌ ${out.result.error}`);
        }
        const missing = needProject();
        if (missing) return txt(missing);
        const choices = parseAiBindings(bindings);
        if (!choices.length) return txt(`❌ ${action} 需要 bindings：{channel_id, mode, group_chat_id?}（先用 channels 看有哪些通道和各自能用的方式）`);
        if (action === "bind") {
          const out = await hostRpc().request<ProjectBindResult>("project.bind", { chatKey, projectId: project_id, bindings: choices }, HOST_ADMIN_TIMEOUT_MS);
          if (!out.ok) return txt(`❌ ${out.error}`);
          if (!out.result) return txt("❌ 应用主进程没有返回结果");
          return txt(out.result.ok ? formatBound(out.result) : `❌ ${out.result.error}`);
        }
        if (choices.length !== 1) return txt("❌ unbind 的 bindings 只放一项（一次取消一个接入）");
        const out = await hostRpc().request<ProjectUnbindResult>("project.unbind", { chatKey, projectId: project_id, binding: choices[0] }, HOST_ADMIN_TIMEOUT_MS);
        if (!out.ok) return txt(`❌ ${out.error}`);
        if (!out.result) return txt("❌ 应用主进程没有返回结果");
        return txt(out.result.ok ? formatUnbound(out.result) : `❌ ${out.result.error}`);
      }
      if (action === "settings") return txt(await callAdmin("project.settings.get", {}));
      if (action === "settings_set") {
        if (!settings) return txt("❌ settings_set 需要 settings：只给要改的项（help topic=settings 看有哪些）");
        return txt(await callAdmin("project.settings.set", {
          settings: {
            worktreeRoot: settings.worktree_root, gitPrinciples: settings.git_principles, resetGitPrinciples: settings.reset_git_principles,
            gitlabHost: settings.gitlab_host, gitlabToken: settings.gitlab_token,
            flowHubUrl: settings.flow_hub_url, flowHubToken: settings.flow_hub_token, flowHubAuthor: settings.flow_hub_author,
          },
        }));
      }
      if (action === "repo_save" || action === "repo_remove") {
        if (!repo?.repo_path?.trim()) return txt(`❌ ${action} 需要 repo.repo_path：本地 git 仓库根目录（绝对路径）或远程地址`);
        return txt(await callAdmin(action === "repo_save" ? "project.repo.save" : "project.repo.remove", {
          repo: {
            repoPath: repo.repo_path, baseBranch: repo.base_branch, testBranch: repo.test_branch,
            developBranch: repo.develop_branch, clone: repo.clone,
          },
        }, HOST_ADMIN_TIMEOUT_MS));
      }
      if (action === "template_save") {
        if (!template) return txt("❌ template_save 需要 template：新建要给 name，修改只给要改的项（help topic=templates 看写法）");
        return txt(await callAdmin("project.template.save", {
          templateId: template_id,
          template: {
            name: template.name, description: template.description, needsRepo: template.needs_repo, workBranch: template.work_branch,
            fields: template.fields, actions: template.actions,
          },
        }));
      }
      if (action === "template_delete") {
        if (!template_id?.trim()) return txt("❌ template_delete 需要 template_id（用 templates 查看）");
        return txt(await callAdmin("project.template.delete", { templateId: template_id }));
      }
      if (action === "templates" && template_id?.trim()) {
        return txt(await callAdmin("project.template.detail", { templateId: template_id, actionId: action_id }));
      }
      if (action === "templates" || action === "repos") {
        const out = await hostRpc().request<ProjectTemplateInfo[] | ProjectRepoOption[]>(
          action === "templates" ? "project.templates" : "project.repos", {}, HOST_QUICK_TIMEOUT_MS,
        )
        if (!out.ok) return txt(`❌ ${out.error}`)
        const rows = Array.isArray(out.result) ? out.result : []
        return txt(action === "templates" ? formatTemplates(rows as ProjectTemplateInfo[]) : formatRepos(rows as ProjectRepoOption[]))
      }
      if (action === "create") {
        const invoker = getMcpInvokerSessionKey()
        if (!invoker) return txt("❌ 无法确定你所在的会话，不能创建项目")
        const choices = parseAiBindings(bindings)
        if (!choices.length) {
          return txt("❌ create 需要 bindings（项目接入哪些消息通道、用什么方式），没有默认值：先用 channels 看有哪些通道、各自能用什么方式，用户没说清楚就问他（send_question）")
        }
        if (!template_id?.trim()) return txt("❌ create 需要 template_id：先用 templates 查看可用模板")
        const out = await hostRpc().request<AiProjectCreateResult>("project.create", {
          chatKey: chatIdFromSessionKey(invoker),
          bindings: choices,
          input: {
            name, goal, templateId: template_id, fields,
            repos: repos?.map((r) => ({ repoPath: r.repo_path, baseBranch: r.base_branch })),
            workBranch: work_branch, featureBranch: feature_branch,
            storyUrl: story_url, relatedDocs: related_docs, folder,
          },
        }, HOST_CREATE_TIMEOUT_MS)
        if (!out.ok) return txt(`❌ ${out.error}`)
        const r = out.result;
        if (!r?.ok) return txt(`❌ ${(r as { error?: string } | undefined)?.error ?? "创建失败"}`)
        return txt(formatCreated(r))
      }
      // 只剩 delete
      const missingForDelete = needProject();
      if (missingForDelete) return txt(missingForDelete);
      const p = getProject(project_id ?? "")
      if (!p) return txt("❌ 未找到项目")
      process.stdout.write(`__PROJECT_DELETE__:${JSON.stringify({ projectId: project_id })}\n`)
      return txt(`✅ 已提交删除「${p.name}」，宿主正在清理 worktree`)
    },
  );

  // ── manage_rules ──

  mcpServer.tool(
    "manage_rules",
    "管理 Harness 规则。",
    {
      action: z.enum(["list", "read", "save", "delete"]).describe("list=列出; read=读取; save=创建或更新; delete=删除"),
      name: z.string().optional().describe("规则 id 或文件名（如 my-rule.mdc）；read/save/delete 必填"),
      content: z.string().optional().describe("规则内容（save 时必填）"),
    },
    async ({ action, name, content }) => {
      try {
        if (action === "list") {
          const data = await daemonGet("/api/rules");
          const rules = data.rules ?? [];
          if (rules.length === 0) return txt("当前没有任何规则文件。");
          return txt(rules.map((f: string) => `- ${f}`).join("\n"));
        }
        if (!name) return txt("错误：name 参数必填");
        if (action === "read") {
          const res = await daemonPost("/api/rules", { action: "read", name });
          return txt(res.ok ? res.content : `❌ ${res.error ?? "读取失败"}`);
        }
        const res = await daemonPost("/api/rules", { action, name, content });
        return txt(res.ok ? `✅ ${res.message}` : `❌ ${res.error ?? "操作失败"}`);
      } catch (e: any) {
        return txt(`❌ Daemon 通信失败: ${e?.message ?? e}`);
      }
    },
  );

  // ── manage_skills ──

  mcpServer.tool(
    "manage_skills",
    "管理 Harness Agent Skills。",
    {
      action: z.enum(["list", "read", "save", "delete"]).describe("list=列出; read=读取 SKILL.md; save=创建或更新; delete=删除"),
      name: z.string().optional().describe("技能目录名（相对 ~/.cursor/skills，可用 / 分层如 group/foo；不能含 ..、绝对路径或盘符）；read/save/delete 必填"),
      content: z.string().optional().describe("SKILL.md 内容（save 时必填）"),
    },
    async ({ action, name, content }) => {
      try {
        if (action === "list") {
          const data = await daemonGet("/api/skills");
          const skills = data.skills ?? [];
          if (skills.length === 0) return txt("当前没有任何技能。");
          return txt(skills.map((s: any) => `- **${s.name}**: ${s.preview || "(无描述)"}`).join("\n"));
        }
        if (!name) return txt("错误：name 参数必填");
        if (action === "read") {
          const res = await daemonPost("/api/skills", { action: "read", name });
          return txt(res.ok ? res.content : `❌ ${res.error ?? "读取失败"}`);
        }
        const res = await daemonPost("/api/skills", { action, name, content });
        return txt(res.ok ? `✅ ${res.message}` : `❌ ${res.error ?? "操作失败"}`);
      } catch (e: any) {
        return txt(`❌ Daemon 通信失败: ${e?.message ?? e}`);
      }
    },
  );

  // ── manage_tasks ──

  mcpServer.tool(
    "manage_tasks",
    [
      "管理全局定时任务（和设置页里的一样）。支持列出、添加/更新、删除、启用/禁用。",
      "注意：这不是「给当前会话定时」。要让你当前所在的会话到点自己做事、或过一阵回来跟进，用 schedule_create（它绑定调用者所在的会话），不要用本工具。",
      "本工具建的任务先定「是否独立运行」，再定「完成后通知谁」（notify）：",
      "- 独立运行（默认）：每次由全新 Agent 执行，它用 send_result 提交结果，没提交就静默。notify=agent（通知 AI）把结果投进会话并唤醒它；notify=im（通知我）以 AI 口吻发给用户，不唤醒任何 Agent；notify=none 不通知。",
      "- independent=false：不启动新 Agent，把任务内容直接送出去。notify=agent（默认）送进会话的 AI，占用它的上下文；notify=im 把任务内容以 AI 口吻直接发给用户。此时 notify=none 无效，按 agent 处理。",
      "通道默认是你当前所在的通道。应用内通道里，目标会话默认就是你当前所在的会话（项目会话除外：通知 AI 落到主会话，通知我没有默认会话，返回的去向会写「未选会话」，要如实告诉用户到设置页选）；飞书/微信里，通知 AI 投给主会话（主用户私聊，回复会发到飞书/微信，不一定是你当前所在的会话），通知我发到主用户私聊。要换通道、指定别的会话或飞书群，请用户到设置页改。",
      "创建 / 修改 / 启用后会返回任务实际的去向，如实转述给用户，不要自己推断。",
    ].join("\n"),
    {
      action: z.enum(["list", "add", "update", "delete", "toggle"]).describe("操作：list=列出, add=新增, update=更新, delete=删除, toggle=切换启用状态"),
      id: z.string().optional().describe("任务 ID（update/delete/toggle 时必填）"),
      name: z.string().optional().describe("任务名称（add 时必填）"),
      cron: z.string().optional().describe("Cron 表达式（add 时必填，update 时可选）"),
      content: z.string().optional().describe("任务消息内容（add 时必填，update 时可选）"),
      enabled: z.boolean().optional().describe("是否启用（add 时默认 true）"),
      independent: z.boolean().optional().describe("是否独立运行（add 时默认 true）。true = 每次由全新 Agent 执行；false = 不启动新 Agent，直接把任务内容送给 notify 指定的对象（agent：进会话 AI 的上下文并占用它；im：以 AI 口吻发给用户）"),
      notify: z.enum(["none", "agent", "im"]).optional().describe("完成后通知谁：agent=通知 AI（独立运行：把 send_result 的结果投进会话并唤醒它；非独立：把任务内容投进会话），im=通知我（独立运行：send_result 的结果以 AI 口吻发给用户；非独立：任务内容直接发给用户，不唤醒 Agent），none=不通知（仅独立运行有效，非独立按 agent 处理）。add 默认：独立运行 im，非独立运行 agent。独立运行的 AI 在任务里用 send_result 提交结果"),
    },
    async ({ action, id, name, cron, content, enabled, independent, notify }) => {
      try {
        // 调用者所在的会话：新建任务默认挂在它所在的通道，并据此告诉 AI「任务是不是投给了它自己」
        const invokerSessionKey = getMcpInvokerSessionKey();
        if (action === "list") {
          const data = await daemonGet(`/api/tasks${invokerSessionKey ? `?invoker=${encodeURIComponent(invokerSessionKey)}` : ""}`);
          const tasks = data.tasks ?? [];
          if (tasks.length === 0) return txt("当前没有定时任务。");
          const lines = tasks.map((t: any) =>
            `- **${t.name}** [${t.enabled ? "✅启用" : "⏸禁用"}] cron=\`${t.cron}\` ${t.independent !== false ? "[独立]" : ""}${t.createdBy === "ai" ? " [AI 自排程]" : ""}\n  ID: ${t.id}\n  内容: ${(t.content ?? "").slice(0, 100)}${(t.content ?? "").length > 100 ? "..." : ""}${t.summary ? `\n${indentLines(String(t.summary), "  ")}` : ""}`,
          );
          return txt(lines.join("\n\n"));
        }
        const body: Record<string, unknown> = { action };
        if (invokerSessionKey) body.invokerSessionKey = invokerSessionKey;
        if (id !== undefined) body.id = id;
        if (name !== undefined) body.name = name;
        if (cron !== undefined) body.cron = cron;
        if (content !== undefined) body.content = content;
        if (enabled !== undefined) body.enabled = enabled;
        if (independent !== undefined) body.independent = independent;
        if (notify !== undefined) body.notify = notify;
        const res = await daemonPost("/api/tasks", body);
        if (res.ok) {
          const where = res.summary ? `\n${res.summary}` : "";
          if (action === "add") return txt(`✅ 任务 "${res.task?.name}" 已创建。ID: ${res.task?.id}${where}`);
          if (action === "delete") return txt(`✅ 任务 "${res.removed?.name}" 已删除。`);
          if (action === "toggle") return txt(`✅ 任务 "${res.task?.name}" 已${res.task?.enabled ? "启用" : "禁用"}。${res.task?.enabled ? where : ""}`);
          if (action === "update") return txt(`✅ 任务 "${res.task?.name}" 已更新。${where}`);
        }
        return txt(`❌ ${res.error ?? "操作失败"}`);
      } catch (e: any) {
        return txt(`❌ Daemon 通信失败: ${e?.message ?? e}`);
      }
    },
  );

  // ── manage_workspace ──

  mcpServer.tool(
    "manage_workspace",
    "管理工作目录。查询当前工作目录或切换到新目录。set 不会立即生效：需主用户在私聊确认卡片上批准（防止会话误切全局目录导致消息窜台），提交后等待用户批准即可，禁止重试。",
    {
      action: z.enum(["get", "set"]).describe("操作：get=查看当前工作目录, set=请求切换工作目录（需主用户批准）"),
      dir: z.string().optional().describe("新的工作目录路径（set 时必填）"),
    },
    async ({ action, dir }) => {
      try {
        if (action === "get") {
          const data = await daemonGet("/api/workspace");
          return txt(`📂 当前工作目录: ${data.workspaceDir || "(未配置)"}`);
        }
        if (!dir?.trim()) return txt("❌ 请提供目录路径（dir 参数）");
        const res = await daemonPost("/api/workspace", { dir: dir.trim() });
        if (res.ok) return txt(`✅ ${res.message}\n📂 ${res.dir}`);
        return txt(`❌ ${res.error ?? "操作失败"}`);
      } catch (e: any) {
        return txt(`❌ Daemon 通信失败: ${e?.message ?? e}`);
      }
    },
  );
}
