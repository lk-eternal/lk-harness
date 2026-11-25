import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MEMORY_LIMITS, deleteSessionMemory, readSessionMemory, saveSessionMemory } from "./shared/session-memory.js";

function reply(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fail(error: string) {
  return reply(`[memory_failed] ${error}`);
}

/**
 * 当前会话的记忆：AI 自己记、自己读。
 * 记忆永远属于调用它的会话（服务端按调用者身份确定，参数里没有也不能指定会话）。
 * dataRoot 是 userData 根目录；读写都落在该会话的目录里，Electron 拼首轮提示词时从同一个文件读。
 */
export function registerMemoryTools(s: McpServer, dataRoot: string, invoker: () => string | undefined): void {
  const target = (): { sk: string } | { error: string } => {
    if (!dataRoot) return { error: "数据目录未配置，不能读写记忆" };
    const sk = invoker()?.trim();
    return sk ? { sk } : { error: "没有识别到调用者所在的会话，不能读写记忆" };
  };

  s.tool(
    "memory_save",
    [
      "记一条当前会话的记忆。对话里只保留最近约 15 轮，更早的内容会丢，记忆不会。",
      "记：用户的决定和约束、已确认的结论、查到的关键事实（ID、路径、数值）、没做完的事和下一步。不记对话原文，也不记能从文件、代码里重新查到的内容。",
      "同一个 key 会覆盖更新，所以事情有变化时用同一个 key 改掉，不要另记一条。",
      "记忆跟着会话走：之后每次新起的会话，首轮都会带上它；只有重置会话才会清空。",
      `最多 ${MEMORY_LIMITS.maxEntries} 条，满了先合并，或用 memory_delete 删掉不再需要的。`,
    ].join("\n"),
    {
      key: z.string().describe(`记忆名，简短（≤${MEMORY_LIMITS.maxKeyChars} 字），同名覆盖`),
      content: z.string().describe(`记忆内容（≤${MEMORY_LIMITS.maxContentChars} 字）`),
    },
    async ({ key, content }) => {
      const t = target();
      if ("error" in t) return fail(t.error);
      const r = saveSessionMemory(dataRoot, t.sk, key, content);
      if (!r.ok) return fail(r.error);
      return reply(`${r.replaced ? "已更新" : "已记下"}「${key.trim()}」（共 ${r.count}/${MEMORY_LIMITS.maxEntries} 条）`);
    },
  );

  s.tool(
    "memory_read",
    "读出当前会话的全部记忆。新起的会话首轮已经把记忆带给你了，一般不用再读；想确认现状时才用。",
    {},
    async () => {
      const t = target();
      if ("error" in t) return fail(t.error);
      const entries = readSessionMemory(dataRoot, t.sk);
      if (entries.length === 0) return reply("当前会话还没有记忆");
      return reply([`共 ${entries.length}/${MEMORY_LIMITS.maxEntries} 条记忆：`, ...entries.map((e) => `- 【${e.key}】${e.content}`)].join("\n"));
    },
  );

  s.tool(
    "memory_delete",
    "删掉当前会话的一条记忆（key 来自 memory_read 或首轮的 memory）。已过期、已做完的要及时删，免得误导之后的会话。",
    { key: z.string().describe("要删的记忆名") },
    async ({ key }) => {
      const t = target();
      if ("error" in t) return fail(t.error);
      const r = deleteSessionMemory(dataRoot, t.sk, key);
      if (!r.ok) return fail(r.error);
      return reply(`已删除「${key.trim()}」（还剩 ${r.count} 条）`);
    },
  );
}
