import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { LOCK_FILE_NAME } from "./shared/constants.js";
import { parseChatKey } from "./shared/channel-types.js";
import { concatUtf8 } from "./shared/utf8-stream.js";

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

export function registerAdminTools(mcpServer: McpServer): void {

  // ── manage_agent ──

  mcpServer.tool(
    "manage_agent",
    "管理应用自身。支持查询状态、停止Agent、重启应用、重置会话、清空队列、启动临时会话。",
    {
      action: z.enum(["status", "stop", "restart", "reset", "clean", "launch"]).describe("操作：status=查询状态, stop=停止Agent, restart=重启, reset=重置会话, clean=清空队列, launch=启动临时Agent会话"),
      message: z.string().optional().describe("任务描述/指令（仅 launch 时使用）"),
      session_key: z.string().optional().describe("当前会话的session_key，用于路由消息（仅 launch 时使用）"),
    },
    async ({ action, message, session_key }) => {
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
          const chatId = session_key?.includes("::") ? session_key.split("::")[0] : session_key;
          const channelId = chatId ? parseChatKey(chatId).channelId : undefined;
          const res = await daemonPost("/api/agent", { action: "launch", message, chatId, channelId });
          return txt(res.ok ? `✅ 临时 Agent 已启动` : `❌ ${res.error ?? "启动失败"}`);
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
    "管理 Cursor MCP 服务器配置。支持列出、添加、删除 MCP 服务器。",
    {
      action: z.enum(["list", "add", "delete"]).describe("操作：list=列出所有, add=添加/更新, delete=删除"),
      name: z.string().optional().describe("MCP 服务器名称（add/delete 时必填）"),
      config: z.string().optional().describe("MCP 服务器配置 JSON（add 时必填），如 {\"command\":\"npx\",\"args\":[\"-y\",\"@some/server\"]}"),
      scope: z.enum(["global", "project"]).optional().describe("配置范围：global=全局, project=项目级。默认 global"),
    },
    async ({ action, name, config, scope }) => {
      try {
        if (action === "list") {
          const data = await daemonGet("/api/mcp");
          const servers = data.servers ?? {};
          if (Object.keys(servers).length === 0) return txt("当前没有配置任何 MCP 服务器。");
          const lines = Object.entries(servers).map(([k, v]: [string, any]) => `- **${k}** [${v.scope}]: ${JSON.stringify(v.config)}`);
          return txt(lines.join("\n"));
        }
        if (!name) return txt("错误：name 参数必填");
        const res = await daemonPost("/api/mcp", { action, name, config, scope: scope ?? "global" });
        return txt(res.ok ? `✅ ${res.message}` : `❌ ${res.error ?? "操作失败"}`);
      } catch (e: any) {
        return txt(`❌ Daemon 通信失败: ${e?.message ?? e}`);
      }
    },
  );

  // ── manage_rules ──

  mcpServer.tool(
    "manage_rules",
    "管理 Cursor Rules 文件。支持列出、读取、添加/更新、删除规则。",
    {
      action: z.enum(["list", "read", "save", "delete"]).describe("操作：list=列出所有, read=读取内容, save=创建或更新, delete=删除"),
      name: z.string().optional().describe("规则文件名（如 my-rule.mdc）。read/save/delete 时必填"),
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
    "管理 Cursor Agent Skills。支持列出、读取、添加/更新、删除技能。",
    {
      action: z.enum(["list", "read", "save", "delete"]).describe("操作：list=列出所有, read=读取内容, save=创建或更新, delete=删除"),
      name: z.string().optional().describe("技能名称（文件夹名）。read/save/delete 时必填"),
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
    "管理定时任务。支持列出、添加/更新、删除、启用/禁用定时任务。",
    {
      action: z.enum(["list", "add", "update", "delete", "toggle"]).describe("操作：list=列出, add=新增, update=更新, delete=删除, toggle=切换启用状态"),
      id: z.string().optional().describe("任务 ID（update/delete/toggle 时必填）"),
      name: z.string().optional().describe("任务名称（add 时必填）"),
      cron: z.string().optional().describe("Cron 表达式（add 时必填，update 时可选）"),
      content: z.string().optional().describe("任务消息内容（add 时必填，update 时可选）"),
      enabled: z.boolean().optional().describe("是否启用（add 时默认 true）"),
      independent: z.boolean().optional().describe("是否独立运行（add 时默认 true）"),
    },
    async ({ action, id, name, cron, content, enabled, independent }) => {
      try {
        if (action === "list") {
          const data = await daemonGet("/api/tasks");
          const tasks = data.tasks ?? [];
          if (tasks.length === 0) return txt("当前没有定时任务。");
          const lines = tasks.map((t: any) =>
            `- **${t.name}** [${t.enabled ? "✅启用" : "⏸禁用"}] cron=\`${t.cron}\` ${t.independent !== false ? "[独立]" : ""}\n  ID: ${t.id}\n  内容: ${(t.content ?? "").slice(0, 100)}${(t.content ?? "").length > 100 ? "..." : ""}`,
          );
          return txt(lines.join("\n\n"));
        }
        const body: Record<string, unknown> = { action };
        if (id !== undefined) body.id = id;
        if (name !== undefined) body.name = name;
        if (cron !== undefined) body.cron = cron;
        if (content !== undefined) body.content = content;
        if (enabled !== undefined) body.enabled = enabled;
        if (independent !== undefined) body.independent = independent;
        const res = await daemonPost("/api/tasks", body);
        if (res.ok) {
          if (action === "add") return txt(`✅ 任务 "${res.task?.name}" 已创建。ID: ${res.task?.id}`);
          if (action === "delete") return txt(`✅ 任务 "${res.removed?.name}" 已删除。`);
          if (action === "toggle") return txt(`✅ 任务 "${res.task?.name}" 已${res.task?.enabled ? "启用" : "禁用"}。`);
          if (action === "update") return txt(`✅ 任务 "${res.task?.name}" 已更新。`);
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
