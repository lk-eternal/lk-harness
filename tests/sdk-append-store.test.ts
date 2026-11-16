import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { JsonlLocalAgentStore } from "@cursor/sdk"
import type { LocalAgentDocument, LocalAgentRunDocument, LocalAgentStore } from "@cursor/sdk"
import { LEGACY_MIGRATE_MAX_BYTES, SdkAppendStore, encodeStoreId } from "../electron/sdk-append-store"
import { SDK_STORE_READY_FILE, SDK_STORE_SUBDIR } from "../electron/sdk-store-layout"

let root: string
let seq = 0

function freshDir(name: string): string {
  const dir = path.join(root, `${name}-${++seq}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function agent(id: string, over: Partial<LocalAgentDocument> = {}): LocalAgentDocument {
  return {
    agentId: id,
    cwd: "/work/a",
    status: "idle",
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  }
}

function run(agentId: string, runId: string, turn: number, over: Partial<LocalAgentRunDocument> = {}): LocalAgentRunDocument {
  return {
    runId,
    agentId,
    turnNumber: turn,
    status: "running",
    createdAt: 2_000 + turn,
    updatedAt: 2_000 + turn,
    ...over,
  }
}

/** 执行一步并把结果/报错文案记进脚本记录，两个实现跑同一份脚本后逐项比较 */
async function step(log: unknown[], label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    log.push([label, "ok", await fn()])
  } catch (e) {
    log.push([label, "err", e instanceof Error ? e.message : String(e)])
  }
}

/** 事件的 createdAt 是墙钟时间，两个实现不可能一致，比较前抹掉 */
function stripTime<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (k, val) => (k === "createdAt" && typeof val === "number" && val > 1e12 ? 0 : val))) as T
}

async function exerciseAgents(s: LocalAgentStore): Promise<unknown[]> {
  const log: unknown[] = []
  await step(log, "get-missing", () => s.agents.get({ agentId: "nope" }))
  for (const [i, id] of ["agent-a", "agent-b", "agent-c", "agent-d", "agent-e"].entries()) {
    await step(log, `create-${id}`, () =>
      s.agents.create({ agent: agent(id, { cwd: i % 2 ? "/work/b" : "/work/a", updatedAt: 1_000 + i }) }))
  }
  await step(log, "create-dup", () => s.agents.create({ agent: agent("agent-a") }))
  await step(log, "update-missing", () => s.agents.update({ agent: agent("ghost") }))
  await step(log, "update-a", () =>
    s.agents.update({ agent: agent("agent-a", { status: "running", updatedAt: 9_000, sdkMetadata: { k: [1, 2] } }) }))
  await step(log, "get-a", () => s.agents.get({ agentId: "agent-a" }))
  await step(log, "list-all", () => s.agents.list())
  await step(log, "list-cwd-b", () => s.agents.list({ filter: { cwd: "/work/b" } }))
  const page1 = await s.agents.list({ filter: { limit: 2 } })
  log.push(["page1", page1])
  await step(log, "page2", () => s.agents.list({ filter: { limit: 2, cursor: page1.nextCursor } }))
  await step(log, "delete-none", () => s.agents.delete({ filter: { agentIds: ["zzz"] } }))
  await step(log, "delete-b", () => s.agents.delete({ filter: { agentIds: ["agent-b"] } }))
  await step(log, "delete-cwd-a", () => s.agents.delete({ filter: { cwd: "/work/a" } }))
  await step(log, "list-after-delete", () => s.agents.list())
  return log
}

async function exerciseRuns(s: LocalAgentStore): Promise<unknown[]> {
  const log: unknown[] = []
  await step(log, "get-missing", () => s.runs.get({ agentId: "a1", runId: "nope" }))
  await step(log, "create-1", () => s.runs.create({ run: run("a1", "run-1", 1) }))
  await step(log, "create-2", () => s.runs.create({ run: run("a1", "run-2", 2) }))
  await step(log, "create-3", () => s.runs.create({ run: run("a1", "run-3", 3) }))
  await step(log, "create-other", () => s.runs.create({ run: run("a2", "run-9", 1) }))
  await step(log, "create-dup", () => s.runs.create({ run: run("a1", "run-1", 1) }))
  await step(log, "update-missing", () => s.runs.update({ run: run("a1", "run-x", 1) }))
  await step(log, "update-1", () =>
    s.runs.update({ run: run("a1", "run-1", 1, { status: "finished", result: "ok", endedAt: 3_000, usage: { inputTokens: 1 } as never }) }))
  await step(log, "get-1", () => s.runs.get({ agentId: "a1", runId: "run-1" }))
  await step(log, "list-all", () => s.runs.list())
  await step(log, "list-a1", () => s.runs.list({ filter: { agentIds: ["a1"] } }))
  await step(log, "list-run-ids", () => s.runs.list({ filter: { runIds: ["run-2", "run-9"] } }))
  const page1 = await s.runs.list({ filter: { agentIds: ["a1"], limit: 2 } })
  log.push(["page1", page1])
  await step(log, "page2", () => s.runs.list({ filter: { agentIds: ["a1"], limit: 2, cursor: page1.nextCursor } }))
  await step(log, "delete-run-2", () => s.runs.delete({ filter: { runIds: ["run-2"] } }))
  await step(log, "list-after-delete", () => s.runs.list({ filter: { agentIds: ["a1"] } }))
  await step(log, "delete-agent-a1", () => s.runs.delete({ filter: { agentIds: ["a1"] } }))
  await step(log, "list-final", () => s.runs.list())
  return log
}

const bytes = (...n: number[]): Uint8Array => Uint8Array.from(n)
const hexOf = (u: Uint8Array | null): string | null => (u ? Buffer.from(u).toString("hex") : null)

async function exerciseCheckpoints(s: LocalAgentStore): Promise<unknown[]> {
  const log: unknown[] = []
  await step(log, "get-missing", async () => hexOf(await s.checkpoints.get({ agentId: "a1", blobId: "b1" })))
  await step(log, "create-b1", () => s.checkpoints.create({ agentId: "a1", blobId: "b1", data: bytes(1, 2, 3) }))
  await step(log, "create-b1-dup", () => s.checkpoints.create({ agentId: "a1", blobId: "b1", data: bytes(9) }))
  await step(log, "update-missing", () => s.checkpoints.update({ agentId: "a1", blobId: "bX", data: bytes(9) }))
  await step(log, "update-b1", () => s.checkpoints.update({ agentId: "a1", blobId: "b1", data: bytes(4, 5, 6, 7) }))
  await step(log, "get-b1", async () => hexOf(await s.checkpoints.get({ agentId: "a1", blobId: "b1" })))
  for (const id of ["b3", "b2", "b5", "b4"]) {
    await step(log, `create-${id}`, () => s.checkpoints.create({ agentId: "a1", blobId: id, data: bytes(id.charCodeAt(1)) }))
  }
  await step(log, "create-other-agent", () => s.checkpoints.create({ agentId: "a2", blobId: "b1", data: bytes(0) }))
  await step(log, "list-all", () => s.checkpoints.list())
  await step(log, "list-a1", () => s.checkpoints.list({ filter: { agentIds: ["a1"] } }))
  const page1 = await s.checkpoints.list({ filter: { agentIds: ["a1"], limit: 2 } })
  log.push(["page1", page1])
  await step(log, "page2", () => s.checkpoints.list({ filter: { agentIds: ["a1"], limit: 2, cursor: page1.nextCursor } }))
  await step(log, "delete-b2", () => s.checkpoints.delete({ filter: { agentIds: ["a1"], blobIds: ["b2"] } }))
  await step(log, "list-after-delete", () => s.checkpoints.list({ filter: { agentIds: ["a1"] } }))
  await step(log, "delete-agent", () => s.checkpoints.delete({ filter: { agentIds: ["a1"] } }))
  await step(log, "list-final", () => s.checkpoints.list())
  return log
}

async function exerciseEvents(s: LocalAgentStore): Promise<unknown[]> {
  const log: unknown[] = []
  await step(log, "list-empty", () => s.runEvents.list({ runId: "r1" }))
  for (let i = 1; i <= 5; i++) {
    await step(log, `append-${i}`, () =>
      s.runEvents.append({ runId: "r1", eventType: "msg", payload: { i, text: `事件 ${i}` }, ...(i === 3 ? { idempotencyKey: "k3" } : {}) }))
  }
  await step(log, "append-idem-hit", () => s.runEvents.append({ runId: "r1", eventType: "msg", payload: { i: 999 }, idempotencyKey: "k3" }))
  await step(log, "append-ref", () => s.runEvents.append({ runId: "r1", eventType: "blob", payloadRef: "ref-1" }))
  await step(log, "append-other-run", () => s.runEvents.append({ runId: "r2", eventType: "msg", payload: "x" }))
  await step(log, "list-all", () => s.runEvents.list({ runId: "r1" }))
  const page1 = await s.runEvents.list({ runId: "r1", limit: 2 })
  log.push(["page1", page1])
  await step(log, "page2", () => s.runEvents.list({ runId: "r1", limit: 2, afterOffset: page1.nextOffset }))
  await step(log, "page-last", () => s.runEvents.list({ runId: "r1", limit: 10, afterOffset: "5" }))
  await step(log, "after-end", () => s.runEvents.list({ runId: "r1", afterOffset: "6" }))
  await step(log, "delete-r1", () => s.runEvents.delete({ filter: { runIds: ["r1"] } }))
  await step(log, "list-r1-after-delete", () => s.runEvents.list({ runId: "r1" }))
  await step(log, "list-r2", () => s.runEvents.list({ runId: "r2" }))
  await step(log, "append-after-delete", () => s.runEvents.append({ runId: "r1", eventType: "msg", payload: "again" }))
  return log
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-append-store-"))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe("SdkAppendStore 与 SDK 自带 JsonlLocalAgentStore 行为一致（差分）", () => {
  // 第三项：参考实现在该脚本里是否有会报错的操作（runEvents 的追加/列表/删除本身没有报错路径）
  const suites: [string, (s: LocalAgentStore) => Promise<unknown[]>, boolean][] = [
    ["agents", exerciseAgents, true],
    ["runs", exerciseRuns, true],
    ["checkpoints", exerciseCheckpoints, true],
    ["runEvents", exerciseEvents, false],
  ]
  for (const [name, exercise, hasErrors] of suites) {
    it(`${name}：同一份脚本的结果和报错文案完全相同`, async () => {
      const reference = stripTime(await exercise(new JsonlLocalAgentStore(freshDir("ref"))))
      const actual = stripTime(await exercise(new SdkAppendStore(freshDir("new"))))
      // 防空转：脚本里要有足够多成功的操作；该有报错路径的脚本要真的触发过报错，否则「两边一致」没有意义
      const kinds = (reference as unknown[][]).map((r) => r[1])
      expect(kinds.filter((k) => k === "ok").length).toBeGreaterThan(5)
      expect(kinds.filter((k) => k === "err").length > 0).toBe(hasErrors)
      expect(actual).toEqual(reference)
    })
  }
})

describe("SdkAppendStore 持久化", () => {
  it("重新打开后数据都在，事件序号接着走、幂等键依然有效", async () => {
    const dir = freshDir("persist")
    const a = new SdkAppendStore(dir)
    await a.agents.create({ agent: agent("ag1") })
    await a.runs.create({ run: run("ag1", "run-1", 1) })
    await a.checkpoints.create({ agentId: "ag1", blobId: "blob-1", data: bytes(7, 8, 9) })
    await a.runEvents.append({ runId: "run-1", eventType: "msg", payload: 1, idempotencyKey: "k1" })
    await a.runEvents.append({ runId: "run-1", eventType: "msg", payload: 2 })

    const b = new SdkAppendStore(dir)
    expect((await b.agents.get({ agentId: "ag1" }))?.agentId).toBe("ag1")
    expect((await b.runs.get({ agentId: "ag1", runId: "run-1" }))?.turnNumber).toBe(1)
    expect(hexOf(await b.checkpoints.get({ agentId: "ag1", blobId: "blob-1" }))).toBe("070809")
    const hit = await b.runEvents.append({ runId: "run-1", eventType: "msg", payload: 99, idempotencyKey: "k1" })
    expect(hit.seq).toBe(1)
    const next = await b.runEvents.append({ runId: "run-1", eventType: "msg", payload: 3 })
    expect(next.seq).toBe(3)
    const all = await b.runEvents.list({ runId: "run-1" })
    expect(all.items.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it("事件日志尾部是写到一半的行（崩溃）：跳过坏行并修复，后续追加不会毁掉相邻行", async () => {
    const dir = freshDir("crash")
    const a = new SdkAppendStore(dir)
    await a.runEvents.append({ runId: "run-1", eventType: "msg", payload: "one" })
    await a.runEvents.append({ runId: "run-1", eventType: "msg", payload: "two" })
    const file = path.join(dir, SDK_STORE_SUBDIR, "events", "run-1.ndjson")
    fs.appendFileSync(file, '{"runId":"run-1","seq":3,"offset":"3","eventType":"ms')

    const warnings: string[] = []
    const b = new SdkAppendStore(dir, { log: (level, m) => { if (level === "WARN") warnings.push(m) } })
    const listed = await b.runEvents.list({ runId: "run-1" })
    expect(listed.items.map((e) => e.payload)).toEqual(["one", "two"])
    expect(warnings.length).toBe(1)

    const three = await b.runEvents.append({ runId: "run-1", eventType: "msg", payload: "three" })
    expect(three.seq).toBe(3)
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
    expect(lines.length).toBe(3)
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow()
  })

  it("agent 文件损坏时读取报错带文件信息，而不是静默当成不存在", async () => {
    const dir = freshDir("corrupt")
    const a = new SdkAppendStore(dir)
    await a.agents.create({ agent: agent("ag1") })
    fs.writeFileSync(path.join(dir, SDK_STORE_SUBDIR, "agents", "ag1.json"), "{not json")
    await expect(new SdkAppendStore(dir).agents.get({ agentId: "ag1" })).rejects.toThrow(/Corrupt local agent store/)
  })

  it("写入不留 .tmp 残留，列表也不会把临时文件当成记录", async () => {
    const dir = freshDir("tmp")
    const s = new SdkAppendStore(dir)
    for (let i = 0; i < 20; i++) await s.checkpoints.create({ agentId: "ag1", blobId: `blob-${i}`, data: bytes(i) })
    await s.agents.create({ agent: agent("ag1") })
    const leftovers: string[] = []
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name))
        else if (e.name.endsWith(".tmp")) leftovers.push(e.name)
      }
    }
    walk(dir)
    expect(leftovers).toEqual([])
    expect((await s.checkpoints.list()).items.length).toBe(20)
  })
})

describe("SdkAppendStore 并发", () => {
  it("同一个 run 并发追加：序号连续不重复，文件行数正确", async () => {
    const dir = freshDir("concurrent")
    const s = new SdkAppendStore(dir)
    const docs = await Promise.all(
      Array.from({ length: 60 }, (_, i) => s.runEvents.append({ runId: "run-1", eventType: "msg", payload: i })),
    )
    expect(docs.map((d) => d.seq).sort((x, y) => x - y)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1))
    const lines = fs.readFileSync(path.join(dir, SDK_STORE_SUBDIR, "events", "run-1.ndjson"), "utf8").split("\n").filter(Boolean)
    expect(lines.length).toBe(60)
  })

  it("同一个幂等键并发追加只产生一条", async () => {
    const s = new SdkAppendStore(freshDir("idem"))
    const docs = await Promise.all(
      Array.from({ length: 10 }, () => s.runEvents.append({ runId: "run-1", eventType: "msg", payload: 1, idempotencyKey: "same" })),
    )
    expect(new Set(docs.map((d) => d.seq)).size).toBe(1)
    expect((await s.runEvents.list({ runId: "run-1" })).items.length).toBe(1)
  })

  it("不同 run 的事件互不影响，缓存淘汰后读回的内容仍然完整", async () => {
    const dir = freshDir("evict")
    const s = new SdkAppendStore(dir)
    // 超过缓存上限的 run 数，逐个写两条，再回头读最早的几个
    for (let r = 0; r < 20; r++) {
      await s.runEvents.append({ runId: `run-${r}`, eventType: "msg", payload: `a${r}` })
      await s.runEvents.append({ runId: `run-${r}`, eventType: "msg", payload: `b${r}` })
    }
    for (const r of [0, 1, 19]) {
      const listed = await s.runEvents.list({ runId: `run-${r}` })
      expect(listed.items.map((e) => e.payload)).toEqual([`a${r}`, `b${r}`])
    }
    const more = await s.runEvents.append({ runId: "run-0", eventType: "msg", payload: "c0" })
    expect(more.seq).toBe(3)
  })

  it("删除事件与排队中的追加竞争：删除之后的追加从 1 重新开始，不会续着旧序号", async () => {
    const dir = freshDir("del-race")
    const s = new SdkAppendStore(dir)
    await s.runEvents.append({ runId: "run-1", eventType: "msg", payload: "old1" })
    await s.runEvents.append({ runId: "run-1", eventType: "msg", payload: "old2" })
    const del = s.runEvents.delete({ filter: { runIds: ["run-1"] } })
    const after = s.runEvents.append({ runId: "run-1", eventType: "msg", payload: "new" })
    await del
    expect((await after).seq).toBe(1)
    const listed = await new SdkAppendStore(dir).runEvents.list({ runId: "run-1" })
    expect(listed.items.map((e) => e.payload)).toEqual(["new"])
  })
})

describe("SdkAppendStore 关闭", () => {
  it("关闭后所有操作被拒绝，也不会把已清掉的目录又建回来", async () => {
    const dir = freshDir("closed")
    const s = new SdkAppendStore(dir)
    await s.agents.create({ agent: agent("ag1") })
    fs.rmSync(dir, { recursive: true, force: true })
    s.close()
    await expect(s.agents.create({ agent: agent("ag2") })).rejects.toThrow(/closed/)
    await expect(s.checkpoints.create({ agentId: "ag1", blobId: "b", data: bytes(1) })).rejects.toThrow(/closed/)
    await expect(s.runEvents.append({ runId: "r", eventType: "msg" })).rejects.toThrow(/closed/)
    await expect(s.prepare()).rejects.toThrow(/closed/)
    expect(fs.existsSync(dir)).toBe(false)
  })
})

describe("SdkAppendStore 旧布局（SDK 自带 ndjson）", () => {
  async function seedLegacy(dir: string): Promise<void> {
    const legacy = new JsonlLocalAgentStore(dir)
    await legacy.agents.create({ agent: agent("ag1", { updatedAt: 5_000 }) })
    await legacy.runs.create({ run: run("ag1", "run-1", 1, { status: "finished" }) })
    await legacy.runs.create({ run: run("ag1", "run-2", 2) })
    await legacy.checkpoints.create({ agentId: "ag1", blobId: "blob-1", data: bytes(1, 2, 3) })
    await legacy.checkpoints.create({ agentId: "ag1", blobId: "blob-2", data: bytes(250, 251, 252) })
    await legacy.runEvents.append({ runId: "run-1", eventType: "msg", payload: { n: 1 }, idempotencyKey: "k1" })
    await legacy.runEvents.append({ runId: "run-1", eventType: "msg", payload: { n: 2 } })
  }

  it("首次打开把旧 ndjson 迁移到新布局，旧文件随后删除", async () => {
    const dir = freshDir("legacy")
    await seedLegacy(dir)
    expect(fs.existsSync(path.join(dir, "checkpoints.ndjson"))).toBe(true)

    const s = new SdkAppendStore(dir)
    const prepared = await s.prepare()
    expect(prepared.migratedBytes).toBeGreaterThan(0)
    expect(prepared.discardedLegacyBytes).toBe(0)

    expect((await s.agents.get({ agentId: "ag1" }))?.updatedAt).toBe(5_000)
    expect((await s.runs.list({ filter: { agentIds: ["ag1"] } })).items.map((r) => r.runId)).toEqual(["run-1", "run-2"])
    expect(hexOf(await s.checkpoints.get({ agentId: "ag1", blobId: "blob-2" }))).toBe("fafbfc")
    const events = await s.runEvents.list({ runId: "run-1" })
    expect(events.items.map((e) => e.payload)).toEqual([{ n: 1 }, { n: 2 }])
    expect(events.items.every((e) => typeof e.createdAt === "number" && e.createdAt > 1e12)).toBe(true)
    // 幂等键与序号在迁移后依然成立
    expect((await s.runEvents.append({ runId: "run-1", eventType: "msg", idempotencyKey: "k1" })).seq).toBe(1)
    expect((await s.runEvents.append({ runId: "run-1", eventType: "msg" })).seq).toBe(3)

    for (const f of ["agents", "runs", "run_events", "checkpoints"]) {
      expect(fs.existsSync(path.join(dir, `${f}.ndjson`))).toBe(false)
    }
    expect(fs.existsSync(path.join(dir, SDK_STORE_SUBDIR, SDK_STORE_READY_FILE))).toBe(true)
  })

  it("迁移只做一次：再次打开不重复迁移", async () => {
    const dir = freshDir("legacy-once")
    await seedLegacy(dir)
    await new SdkAppendStore(dir).prepare()
    const again = await new SdkAppendStore(dir).prepare()
    expect(again).toEqual({ migratedBytes: 0, discardedLegacyBytes: 0 })
  })

  it("旧 ndjson 里有坏行：跳过坏行，其余照常迁移", async () => {
    const dir = freshDir("legacy-bad")
    await seedLegacy(dir)
    fs.appendFileSync(path.join(dir, "runs.ndjson"), "{broken\n")
    const s = new SdkAppendStore(dir)
    await s.prepare()
    expect((await s.runs.list()).items.length).toBe(2)
  })

  it("旧存储超过迁移上限：不迁移直接丢弃，并如实告知调用方", async () => {
    const dir = freshDir("legacy-huge")
    const fd = fs.openSync(path.join(dir, "checkpoints.ndjson"), "w")
    fs.ftruncateSync(fd, LEGACY_MIGRATE_MAX_BYTES + 1)
    fs.closeSync(fd)

    const s = new SdkAppendStore(dir)
    const prepared = await s.prepare()
    expect(prepared.discardedLegacyBytes).toBeGreaterThan(LEGACY_MIGRATE_MAX_BYTES)
    expect(prepared.migratedBytes).toBe(0)
    expect(fs.existsSync(path.join(dir, "checkpoints.ndjson"))).toBe(false)
    expect((await s.agents.list()).items).toEqual([])
    expect(await s.agents.get({ agentId: "ag1" })).toBeNull()
  })

  it("全新目录：prepare 什么都不做，只落一个就绪标记", async () => {
    const dir = freshDir("fresh")
    const prepared = await new SdkAppendStore(dir).prepare()
    expect(prepared).toEqual({ migratedBytes: 0, discardedLegacyBytes: 0 })
    expect(fs.existsSync(path.join(dir, SDK_STORE_SUBDIR, SDK_STORE_READY_FILE))).toBe(true)
  })

  it("构造函数不碰文件系统（目录不存在也不报错）", () => {
    const dir = path.join(root, "never-created")
    expect(() => new SdkAppendStore(dir)).not.toThrow()
    expect(fs.existsSync(dir)).toBe(false)
  })
})

describe("encodeStoreId", () => {
  it("常见 id 原样保留（小写字母/数字/连字符）", () => {
    expect(encodeStoreId("agent-3f2a9c1e-77ab")).toBe("agent-3f2a9c1e-77ab")
    expect(encodeStoreId("0123456789abcdef")).toBe("0123456789abcdef")
  })

  it("路径分隔符、Windows 非法字符、大写都被转义；结果不含任何非法文件名字符", () => {
    for (const id of ["a/b", "a\\b", "a:b", "a*b", 'a"b', "a<b>", "a|b", "a?b", "..", ".", "a.", "A", "中文 id", "x%y"]) {
      const out = encodeStoreId(id)
      expect(out).toMatch(/^[a-z0-9._%-]*$|^[a-z0-9._%A-F-]*$/)
      expect(out).not.toMatch(/[\\/:*?"<>|]/)
      expect(out).not.toMatch(/^\.+$/)
      expect(out.endsWith(".")).toBe(false)
    }
  })

  it("不同 id 编码不同（含只差大小写、含百分号的 id），空 id 报错", () => {
    const ids = ["a", "A", "a%41", "a.b", "a%2Eb", "..", "%2E%2E", "a/b", "a%2Fb"]
    expect(new Set(ids.map(encodeStoreId.bind(null))).size).toBe(ids.length)
    expect(new Set(ids.map((i) => encodeStoreId(i).toLowerCase())).size).toBe(ids.length)
    expect(() => encodeStoreId("")).toThrow()
  })

  it("奇怪的 id 实际能当文件名用，并且能原样读回、列出", async () => {
    const s = new SdkAppendStore(freshDir("odd-ids"))
    const ids = ["agent/with/slash", "Agent:Colon*Star", "UPPER", "upper", "中文", "dots.."]
    for (const id of ids) await s.agents.create({ agent: agent(id) })
    for (const id of ids) expect((await s.agents.get({ agentId: id }))?.agentId).toBe(id)
    expect((await s.agents.list()).items.map((a) => a.agentId).sort()).toEqual([...ids].sort())
  })
})

describe("SdkAppendStore 性能：成本与存储总量无关", () => {
  it("大量事件与 blob 之后，单次追加/读取依然很快（旧实现是整文件重写，同样规模要几分钟）", async () => {
    const dir = freshDir("perf")
    const s = new SdkAppendStore(dir)
    const payload = { text: "x".repeat(1500) }

    const started = Date.now()
    for (let i = 0; i < 4000; i++) await s.runEvents.append({ runId: "run-1", eventType: "msg", payload })
    // 6MB 的事件日志，再追加一条：只写这一行
    const t1 = Date.now()
    await s.runEvents.append({ runId: "run-1", eventType: "msg", payload })
    const appendAfterLarge = Date.now() - t1

    const big = Buffer.alloc(200_000, 7)
    for (let i = 0; i < 150; i++) {
      await s.checkpoints.create({ agentId: "ag1", blobId: `blob-${i}`, data: big })
      await s.checkpoints.get({ agentId: "ag1", blobId: `blob-${i}` })
    }
    const t2 = Date.now()
    await s.checkpoints.create({ agentId: "ag1", blobId: "blob-last", data: big })
    const createAfterLarge = Date.now() - t2

    const t3 = Date.now()
    const tail = await s.runEvents.list({ runId: "run-1", afterOffset: "4000" })
    const listTail = Date.now() - t3

    expect(tail.items.length).toBe(1)
    expect(appendAfterLarge).toBeLessThan(500)
    expect(createAfterLarge).toBeLessThan(500)
    expect(listTail).toBeLessThan(200)
    expect(Date.now() - started).toBeLessThan(60_000)
  }, 90_000)
})
