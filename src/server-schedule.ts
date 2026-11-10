import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AiScheduleInput } from "./shared/ai-schedule.js";

export type ScheduleApiResult = { ok: true; text: string } | { ok: false; error: string };

/** daemon 提供的实现：身份判定、写任务文件、清理都在那边；这里只管工具的形状和说明 */
export interface ScheduleApi {
  create(invoker: string | undefined, input: AiScheduleInput): ScheduleApiResult;
  list(invoker: string | undefined): ScheduleApiResult;
  cancel(invoker: string | undefined, id: string): ScheduleApiResult;
}

function reply(r: ScheduleApiResult) {
  return { content: [{ type: "text" as const, text: r.ok ? r.text : `[schedule_failed] ${r.error}` }] };
}

/**
 * 给 AI 自己排定时任务：到点执行、可限次数 / 过期、可取消。
 * 排程永远绑定调用它的会话（服务端按调用者身份确定，参数里没有也不能指定会话）。
 */
export function registerScheduleTools(s: McpServer, api: ScheduleApi, invoker: () => string | undefined): void {
  s.tool(
    "schedule_create",
    [
      "给自己排一个定时任务，到点自动执行（如等 CI、盯缺陷、定期检查）。",
      'mode="fresh"（默认）：每次由新 Agent 执行，有结论才投回本会话，没事可报时它可以静默；mode="session"：到点提醒本会话自己做。',
      "prompt 要自包含：执行者看不到当前对话；fresh 模式下写明什么情况下才汇报。",
    ].join("\n"),
    {
      name: z.string().describe("排程名称"),
      prompt: z.string().describe("到点要执行的内容"),
      every_minutes: z.number().optional().describe("每隔多少分钟触发一次，与 cron 二选一"),
      cron: z.string().optional().describe("cron 表达式（5 段，本地时区），与 every_minutes 二选一"),
      mode: z.enum(["fresh", "session"]).optional().describe("执行方式，默认 fresh"),
      max_runs: z.number().optional().describe("最多触发几次，与 expires_in_hours 二选一必填"),
      expires_in_hours: z.number().optional().describe("多少小时后过期，与 max_runs 二选一必填"),
    },
    async (a) => reply(api.create(invoker(), {
      name: a.name,
      prompt: a.prompt,
      everyMinutes: a.every_minutes,
      cron: a.cron,
      mode: a.mode,
      maxRuns: a.max_runs,
      expiresInHours: a.expires_in_hours,
    })),
  );

  s.tool(
    "schedule_list",
    "列出本会话名下的 AI 排程（id、做什么、已触发次数、过期时间）。只能看到自己会话的，看不到用户在设置页建的定时任务。",
    {},
    async () => reply(api.list(invoker())),
  );

  s.tool(
    "schedule_cancel",
    "取消本会话名下的一个 AI 排程（id 来自 schedule_list）。只能取消自己会话的。",
    { id: z.string().describe("排程 id") },
    async ({ id }) => reply(api.cancel(invoker(), id)),
  );
}
