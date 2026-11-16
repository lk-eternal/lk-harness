/**
 * Cursor SDK 本地存储（LocalAgentStore）的「只追加 + 按键分文件」实现，替代 SDK 自带的 JsonlLocalAgentStore。
 *
 * 为什么要换：SDK 自带的 JSONL 存储每次读写都是「整文件读出 → 全部 JSON.parse → 改一条 → 全部 stringify → 整文件写回」，
 * 而且全进程只有一把写锁。一个回合跑一个多小时后 checkpoints.ndjson 能到百 MB：
 *   - 每新增一个 blob：get（整文件扫描）+ create（整文件读 + 整文件重写）
 *   - 每个 run 事件：整个 run_events.ndjson 读出再重写
 *   - 恢复会话：列出全部 blob 再逐个 get ＝ N 次整文件扫描（实测 3172 个 blob、100MB，约 10 分钟）
 * 结果是主进程 CPU 打满、堆内存冲到几百 MB、所有会话在同一把锁上排队。
 *
 * 这里的布局让每个操作的成本只和「这一条记录」有关，与存储总量无关：
 *   store2/agents/<agentId>.json            每个 agent 一个小 JSON
 *   store2/runs/<agentId>/<runId>.json      每个 run 一个小 JSON
 *   store2/events/<runId>.ndjson            每个 run 一个只追加的事件日志（序号/幂等键在内存缓存里）
 *   store2/blobs/<agentId>/<blobId>         每个 checkpoint blob 一个文件（内容寻址，原始字节，不再 base64）
 * 所有「整条替换」的写入都是「先写临时文件再 rename」，崩溃不会留下半个文件；
 * 只对同一个键串行（同一 blob / 同一 run 的事件 / 同一 agent），不同会话互不排队。
 *
 * 行为与 JsonlLocalAgentStore 保持一致（重复创建/缺失更新的报错文案、分页排序、事件幂等键、删除语义），
 * 由 tests/sdk-append-store.test.ts 的差分测试守住。
 *
 * 旧数据：首次打开时把旧 ndjson 流式迁移到新布局；超过 LEGACY_MIGRATE_MAX_BYTES 的不迁移，直接丢弃
 * （由调用方用 mirror 历史冷启动——与账本超限滚动重开是同一条路径）。
 */
import * as fs from "node:fs"
import { promises as fsp } from "node:fs"
import * as path from "node:path"
import { createInterface } from "node:readline"
import { randomBytes } from "node:crypto"
import { paginateAgentDocuments, paginateCheckpointBlobIds, paginateRunDocuments } from "@cursor/sdk"
import type {
  LocalAgentAgentFilter,
  LocalAgentCheckpointFilter,
  LocalAgentDocument,
  LocalAgentListFilter,
  LocalAgentRunDocument,
  LocalAgentRunEventDocument,
  LocalAgentRunEventListResult,
  LocalAgentRunFilter,
  LocalAgentStore,
  LocalAgentStoreAgents,
  LocalAgentStoreCheckpoints,
  LocalAgentStoreListResult,
  LocalAgentStoreRunEvents,
  LocalAgentStoreRuns,
} from "@cursor/sdk"
import {
  LEGACY_STORE_FILES,
  LEGACY_STORE_FILE_NAMES,
  SDK_STORE_READY_FILE,
  SDK_STORE_SUBDIR,
  STORE_DIRS,
  legacyStoreBytes,
} from "./sdk-store-layout.js"

/** 旧 ndjson 合计超过这个体积就不迁移：这类会话本来就该被账本限额（10MB）滚动重开，迁过去只会白白占内存 */
export const LEGACY_MIGRATE_MAX_BYTES = 48 * 1024 * 1024
/** 每个 run 事件缓存在内存里的 run 数上限（活跃 run 的事件才需要常驻，其余按最近使用淘汰） */
const EVENT_CACHE_MAX_RUNS = 8
const RUN_EVENT_LIST_DEFAULT_LIMIT = 100

export interface SdkStorePrepareResult {
  /** 本次从旧 ndjson 迁移过来的字节数（0 = 没有旧数据或早已迁移） */
  migratedBytes: number
  /** 因超过 LEGACY_MIGRATE_MAX_BYTES 被丢弃的旧 ndjson 字节数（0 = 没有丢弃） */
  discardedLegacyBytes: number
}

export interface SdkAppendStoreOptions {
  /** 诊断日志（迁移/丢弃/跳过坏行）。不传则静默 */
  log?: (level: "INFO" | "WARN", message: string) => void
}

// ── 小工具 ─────────────────────────────────────────

/**
 * id → 安全文件名（跨 Windows/macOS）：encodeURIComponent 再补转义 Windows 不允许的 * 等，纯点/结尾点也转义；
 * 大写字母也转义——macOS/Windows 默认不区分大小写，只差大小写的两个 id 不能落到同一个文件上。
 */
export function encodeStoreId(id: string): string {
  if (!id) throw new Error("Invalid store id: empty")
  let out = encodeURIComponent(id).replace(/[A-Z!~*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
  if (/^\.+$/.test(out)) out = out.replace(/\./g, "%2E")
  else if (out.endsWith(".")) out = out.slice(0, -1) + "%2E"
  return out
}

function decodeStoreId(name: string): string {
  try { return decodeURIComponent(name) } catch { return name }
}

/** 按键串行：同键的操作排队，不同键并发；队尾空了就清理，不积累 */
class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>()

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve()
    const result = prev.then(fn, fn)
    const tail = result.then(() => undefined, () => undefined)
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return result
  }
}

function isErrno(e: unknown, ...codes: string[]): boolean {
  const c = (e as NodeJS.ErrnoException | undefined)?.code
  return typeof c === "string" && codes.includes(c)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Windows 上杀软/索引器会短暂占住文件：rename 遇到 EPERM/EBUSY/EACCES 退避重试 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(from, to)
      return
    } catch (e) {
      if (attempt >= 6 || !isErrno(e, "EPERM", "EBUSY", "EACCES")) throw e
      await sleep(15 * (attempt + 1))
    }
  }
}

/** 整条替换写：先写同目录临时文件再 rename；目录不存在（如会话被清理后重建）就补建后重试一次 */
async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`
  try {
    await fsp.writeFile(tmp, data)
  } catch (e) {
    if (!isErrno(e, "ENOENT")) throw e
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(tmp, data)
  }
  try {
    await renameWithRetry(tmp, file)
  } catch (e) {
    await fsp.unlink(tmp).catch(() => undefined)
    throw e
  }
}

async function appendLine(file: string, line: string): Promise<void> {
  try {
    await fsp.appendFile(file, line)
  } catch (e) {
    if (!isErrno(e, "ENOENT")) throw e
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.appendFile(file, line)
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  let raw: string
  try {
    raw = await fsp.readFile(file, "utf8")
  } catch (e) {
    if (isErrno(e, "ENOENT")) return null
    throw e
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new Error(`Corrupt local agent store: failed to parse ${file}`)
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fsp.access(file)
    return true
  } catch {
    return false
  }
}

/** 列目录条目名；目录不存在返回空；跳过临时文件 */
async function listNames(dir: string): Promise<string[]> {
  try {
    return (await fsp.readdir(dir)).filter((n) => !n.endsWith(".tmp"))
  } catch (e) {
    if (isErrno(e, "ENOENT", "ENOTDIR")) return []
    throw e
  }
}

async function unlinkQuiet(file: string): Promise<void> {
  try {
    await fsp.unlink(file)
  } catch (e) {
    if (!isErrno(e, "ENOENT")) throw e
  }
}

const clone = <T>(v: T): T => structuredClone(v)

// ── 过滤语义（与 JsonlLocalAgentStore 一致） ───────────

function matchAgent(a: LocalAgentDocument, f?: LocalAgentAgentFilter): boolean {
  if (f?.agentIds?.length && !f.agentIds.includes(a.agentId)) return false
  return f?.cwd === undefined || a.cwd === f.cwd
}

function matchRun(r: LocalAgentRunDocument, f?: Pick<LocalAgentRunFilter, "agentIds" | "runIds">): boolean {
  if (f?.agentIds && f.agentIds.length > 0 && !f.agentIds.includes(r.agentId)) return false
  if (f?.runIds && f.runIds.length > 0 && !f.runIds.includes(r.runId)) return false
  return true
}

function matchBlob(agentId: string, blobId: string, f?: LocalAgentCheckpointFilter): boolean {
  if (f?.agentIds?.length && !f.agentIds.includes(agentId)) return false
  if (f?.blobIds?.length && !f.blobIds.includes(blobId)) return false
  return true
}

// ── 事件日志（内存缓存 + 只追加文件） ─────────────────

interface EventLog {
  events: LocalAgentRunEventDocument[]
  byKey: Map<string, LocalAgentRunEventDocument>
  /** 排队中 + 执行中的操作数；>0 时不淘汰 */
  busy: number
  /** 已从磁盘加载（加载在该 run 的队列里完成，单飞） */
  loaded: boolean
}

/** 旧布局里 createdAt 是 ISO 字符串，新布局是毫秒数；读入时统一成毫秒数 */
function toMs(v: unknown): number {
  return typeof v === "number" ? v : new Date(v as string).getTime()
}

/** 第一个 seq > after 的下标（events 按 seq 升序） */
function firstIndexAfter(events: readonly LocalAgentRunEventDocument[], after: number): number {
  let lo = 0
  let hi = events.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (events[mid].seq > after) hi = mid
    else lo = mid + 1
  }
  return lo
}

export class SdkAppendStore implements LocalAgentStore {
  readonly agents: LocalAgentStoreAgents
  readonly checkpoints: LocalAgentStoreCheckpoints
  readonly runs: LocalAgentStoreRuns
  readonly runEvents: LocalAgentStoreRunEvents

  private readonly base: string
  private readonly queue = new KeyedQueue()
  private readonly eventLogs = new Map<string, EventLog>()
  private readyPromise: Promise<SdkStorePrepareResult> | null = null
  private readonly log: (level: "INFO" | "WARN", message: string) => void

  constructor(private readonly rootDir: string, opts: SdkAppendStoreOptions = {}) {
    this.base = path.join(rootDir, SDK_STORE_SUBDIR)
    this.log = opts.log ?? (() => undefined)
    this.agents = this.buildAgents()
    this.checkpoints = this.buildCheckpoints()
    this.runs = this.buildRuns()
    this.runEvents = this.buildRunEvents()
  }

  /**
   * 确保新布局就绪（旧 ndjson 迁移或丢弃），返回本次做了什么。
   * 每个读写操作内部也会等它；调用方想在拉起前知道「旧存储是否被丢弃」时显式调用。幂等、单飞。
   */
  prepare(): Promise<SdkStorePrepareResult> {
    if (this.closed) return Promise.reject(new Error("SDK store closed"))
    if (!this.readyPromise) {
      this.readyPromise = this.initialize().catch((e) => {
        this.readyPromise = null // 初始化失败允许下次重试
        throw e
      })
    }
    return this.readyPromise
  }

  /**
   * 关闭：之后所有操作拒绝。会话存储被清理（账本滚动/新会话/重置）时由调用方关掉旧实例——
   * 否则旧实例上还在途的写入会因「目录不存在就补建」把刚清掉的目录又写回来。
   */
  close(): void {
    this.closed = true
    this.eventLogs.clear()
  }

  private closed = false

  private assertOpen(): void {
    if (this.closed) throw new Error("SDK store closed")
  }

  private put(file: string, data: string | Uint8Array): Promise<void> {
    this.assertOpen()
    return writeFileAtomic(file, data)
  }

  private appendTo(file: string, line: string): Promise<void> {
    this.assertOpen()
    return appendLine(file, line)
  }

  // ── 路径 ──
  private agentFile(agentId: string): string {
    return path.join(this.base, STORE_DIRS.agents, `${encodeStoreId(agentId)}.json`)
  }
  private runDir(agentId: string): string {
    return path.join(this.base, STORE_DIRS.runs, encodeStoreId(agentId))
  }
  private runFile(agentId: string, runId: string): string {
    return path.join(this.runDir(agentId), `${encodeStoreId(runId)}.json`)
  }
  private eventsDir(): string {
    return path.join(this.base, STORE_DIRS.events)
  }
  private eventsFile(runId: string): string {
    return path.join(this.eventsDir(), `${encodeStoreId(runId)}.ndjson`)
  }
  private blobDir(agentId: string): string {
    return path.join(this.base, STORE_DIRS.blobs, encodeStoreId(agentId))
  }
  private blobFile(agentId: string, blobId: string): string {
    return path.join(this.blobDir(agentId), encodeStoreId(blobId))
  }

  // ── 初始化 / 旧数据迁移 ──
  private async initialize(): Promise<SdkStorePrepareResult> {
    const result: SdkStorePrepareResult = { migratedBytes: 0, discardedLegacyBytes: 0 }
    const readyFile = path.join(this.base, SDK_STORE_READY_FILE)
    // 常见路径（已就绪 / 全新目录）只有几次 stat 和一个几字节的标记文件，同步完成：
    // 拉起路径上不多一次事件循环往返，也不依赖真实异步 I/O（假定时器的测试里不会被卡住）。
    // 只有真要迁移旧数据时才走异步流式读写。
    const alreadyReady = fs.existsSync(readyFile)
    const legacyBytes = legacyStoreBytes(this.rootDir)

    if (!alreadyReady && legacyBytes > 0) {
      if (legacyBytes > LEGACY_MIGRATE_MAX_BYTES) {
        result.discardedLegacyBytes = legacyBytes
        this.log("WARN", `旧存储 ${(legacyBytes / 1048576).toFixed(1)}MB 超过迁移上限 ${LEGACY_MIGRATE_MAX_BYTES / 1048576}MB，丢弃（上下文改由最近对话冷启动）`)
      } else {
        await this.migrateLegacy()
        result.migratedBytes = legacyBytes
        this.log("INFO", `旧存储 ${(legacyBytes / 1048576).toFixed(1)}MB 已迁移到新布局`)
      }
    }

    if (!alreadyReady) {
      this.assertOpen()
      fs.mkdirSync(this.base, { recursive: true })
      fs.writeFileSync(readyFile, JSON.stringify({ version: 1, at: Date.now() }))
    }
    // 迁移/丢弃完成后（或上次清理被打断时）删除旧文件，避免它们继续占盘、被保留机制重复计数
    if (legacyBytes > 0) {
      for (const name of LEGACY_STORE_FILE_NAMES) await unlinkQuiet(path.join(this.rootDir, name)).catch(() => undefined)
    }
    return result
  }

  /** 逐行流式读旧 ndjson，写进新布局。可重入：中途崩溃后下次重做，结果一样（没有 .ready 就不算完成） */
  private async migrateLegacy(): Promise<void> {
    let skipped = 0
    const eachRow = async (name: string, fn: (row: Record<string, unknown>) => Promise<void> | void): Promise<void> => {
      const file = path.join(this.rootDir, name)
      if (!fs.existsSync(file)) return
      const rl = createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity })
      for await (const line of rl) {
        const t = line.trim()
        if (!t) continue
        let row: Record<string, unknown>
        try {
          row = JSON.parse(t) as Record<string, unknown>
        } catch {
          skipped++ // 旧实现也只容忍最后一行坏；这里一律跳过，宁可丢一行也不让会话打不开
          continue
        }
        await fn(row)
      }
    }

    await eachRow(LEGACY_STORE_FILES.agents, async (row) => {
      if (typeof row.agentId !== "string") return
      await this.put(this.agentFile(row.agentId), JSON.stringify(row))
    })
    await eachRow(LEGACY_STORE_FILES.runs, async (row) => {
      if (typeof row.agentId !== "string" || typeof row.runId !== "string") return
      await this.put(this.runFile(row.agentId, row.runId), JSON.stringify(row))
    })
    await eachRow(LEGACY_STORE_FILES.checkpoints, async (row) => {
      if (typeof row.agentId !== "string" || typeof row.blobId !== "string" || typeof row.dataBase64 !== "string") return
      await this.put(this.blobFile(row.agentId, row.blobId), Buffer.from(row.dataBase64, "base64"))
    })
    // 事件：按 run 收集后每个 run 一次性写出（总量已被迁移上限卡住，内存可控）
    const perRun = new Map<string, string[]>()
    await eachRow(LEGACY_STORE_FILES.runEvents, (row) => {
      if (typeof row.runId !== "string") return
      const doc = { ...row, createdAt: toMs(row.createdAt) }
      const lines = perRun.get(row.runId) ?? []
      lines.push(JSON.stringify(doc))
      perRun.set(row.runId, lines)
    })
    for (const [runId, lines] of perRun) {
      await this.put(this.eventsFile(runId), lines.join("\n") + "\n")
    }
    if (skipped > 0) this.log("WARN", `迁移旧存储时跳过 ${skipped} 条无法解析的记录`)
  }

  // ── agents ──
  private buildAgents(): LocalAgentStoreAgents {
    const readAll = async (): Promise<LocalAgentDocument[]> => {
      const names = (await listNames(path.join(this.base, STORE_DIRS.agents))).filter((n) => n.endsWith(".json"))
      const docs = await Promise.all(names.map((n) => readJson<LocalAgentDocument>(path.join(this.base, STORE_DIRS.agents, n))))
      return docs.filter((d): d is LocalAgentDocument => d !== null)
    }
    return {
      get: async ({ agentId }) => {
        await this.prepare()
        return readJson<LocalAgentDocument>(this.agentFile(agentId))
      },
      create: async ({ agent }) => {
        await this.prepare()
        return this.queue.run(`a:${agent.agentId}`, async () => {
          if (await exists(this.agentFile(agent.agentId))) throw new Error(`Agent ${agent.agentId} already exists`)
          const doc = clone(agent)
          await this.put(this.agentFile(agent.agentId), JSON.stringify(doc))
          return clone(doc)
        })
      },
      update: async ({ agent }) => {
        await this.prepare()
        return this.queue.run(`a:${agent.agentId}`, async () => {
          if (!(await exists(this.agentFile(agent.agentId)))) throw new Error(`Agent ${agent.agentId} not found`)
          const doc = clone(agent)
          await this.put(this.agentFile(agent.agentId), JSON.stringify(doc))
          return clone(doc)
        })
      },
      delete: async ({ filter }) => {
        await this.prepare()
        const matched = (await readAll()).filter((a) => matchAgent(a, filter))
        if (matched.length === 0) throw new Error("No agents matched delete filter")
        await Promise.all(matched.map((a) => this.queue.run(`a:${a.agentId}`, () => unlinkQuiet(this.agentFile(a.agentId)))))
      },
      list: async (input) => {
        await this.prepare()
        const filter: LocalAgentListFilter | undefined = input?.filter
        return paginateAgentDocuments(await readAll(), filter) as LocalAgentStoreListResult<LocalAgentDocument>
      },
    }
  }

  // ── checkpoints（blob） ──
  private buildCheckpoints(): LocalAgentStoreCheckpoints {
    const collect = async (filter?: LocalAgentCheckpointFilter): Promise<{ agentId: string; blobId: string }[]> => {
      const blobsRoot = path.join(this.base, STORE_DIRS.blobs)
      const agentDirs = filter?.agentIds?.length
        ? filter.agentIds.map((id) => encodeStoreId(id))
        : await listNames(blobsRoot)
      const out: { agentId: string; blobId: string }[] = []
      for (const dirName of agentDirs) {
        const agentId = decodeStoreId(dirName)
        for (const name of await listNames(path.join(blobsRoot, dirName))) {
          const blobId = decodeStoreId(name)
          if (matchBlob(agentId, blobId, filter)) out.push({ agentId, blobId })
        }
      }
      return out
    }
    return {
      get: async ({ agentId, blobId }) => {
        await this.prepare()
        try {
          return await fsp.readFile(this.blobFile(agentId, blobId))
        } catch (e) {
          if (isErrno(e, "ENOENT")) return null
          throw e
        }
      },
      create: async ({ agentId, blobId, data }) => {
        await this.prepare()
        await this.queue.run(`b:${agentId}:${blobId}`, async () => {
          const file = this.blobFile(agentId, blobId)
          if (await exists(file)) throw new Error(`Checkpoint blob ${blobId} already exists for agent ${agentId}`)
          await this.put(file, data)
        })
      },
      update: async ({ agentId, blobId, data }) => {
        await this.prepare()
        await this.queue.run(`b:${agentId}:${blobId}`, async () => {
          const file = this.blobFile(agentId, blobId)
          if (!(await exists(file))) throw new Error(`Checkpoint blob ${blobId} not found for agent ${agentId}`)
          await this.put(file, data)
        })
      },
      delete: async ({ filter }) => {
        await this.prepare()
        const matched = await collect(filter)
        await Promise.all(matched.map((b) =>
          this.queue.run(`b:${b.agentId}:${b.blobId}`, () => unlinkQuiet(this.blobFile(b.agentId, b.blobId)))))
      },
      list: async (input) => {
        await this.prepare()
        const filter = input?.filter
        const ids = (await collect(filter)).map((b) => b.blobId)
        return paginateCheckpointBlobIds(ids, filter) as LocalAgentStoreListResult<string>
      },
    }
  }

  // ── runs ──
  private buildRuns(): LocalAgentStoreRuns {
    const readAll = async (filter?: Pick<LocalAgentRunFilter, "agentIds" | "runIds">): Promise<LocalAgentRunDocument[]> => {
      const runsRoot = path.join(this.base, STORE_DIRS.runs)
      const dirs = filter?.agentIds?.length
        ? filter.agentIds.map((id) => encodeStoreId(id))
        : await listNames(runsRoot)
      const out: LocalAgentRunDocument[] = []
      for (const dirName of dirs) {
        const names = (await listNames(path.join(runsRoot, dirName))).filter((n) => n.endsWith(".json"))
        const docs = await Promise.all(names.map((n) => readJson<LocalAgentRunDocument>(path.join(runsRoot, dirName, n))))
        for (const d of docs) if (d && matchRun(d, filter)) out.push(d)
      }
      return out
    }
    return {
      get: async ({ agentId, runId }) => {
        await this.prepare()
        return readJson<LocalAgentRunDocument>(this.runFile(agentId, runId))
      },
      create: async ({ run }) => {
        await this.prepare()
        return this.queue.run(`r:${run.agentId}:${run.runId}`, async () => {
          const file = this.runFile(run.agentId, run.runId)
          if (await exists(file)) throw new Error(`Run ${run.runId} already exists for agent ${run.agentId}`)
          const doc = clone(run)
          await this.put(file, JSON.stringify(doc))
          return clone(doc)
        })
      },
      update: async ({ run }) => {
        await this.prepare()
        return this.queue.run(`r:${run.agentId}:${run.runId}`, async () => {
          const file = this.runFile(run.agentId, run.runId)
          if (!(await exists(file))) throw new Error(`Run ${run.runId} not found for agent ${run.agentId}`)
          const doc = clone(run)
          await this.put(file, JSON.stringify(doc))
          return clone(doc)
        })
      },
      delete: async ({ filter }) => {
        await this.prepare()
        const matched = await readAll(filter)
        for (const r of matched) {
          await this.queue.run(`r:${r.agentId}:${r.runId}`, () => unlinkQuiet(this.runFile(r.agentId, r.runId)))
        }
        // 与旧实现一致：删 run 同时删它的事件（逐个 run，避免空过滤器误删全部事件）
        for (const r of matched) await this.runEvents.delete({ filter: { runIds: [r.runId] } })
      },
      list: async (input) => {
        await this.prepare()
        const filter = input?.filter
        return paginateRunDocuments(await readAll(filter), filter) as LocalAgentStoreListResult<LocalAgentRunDocument>
      },
    }
  }

  // ── run events ──
  /** 在同一 run 的队列里执行，并保证事件缓存加载、使用后按 LRU 淘汰 */
  private withEventLog<T>(runId: string, fn: (log: EventLog) => Promise<T>): Promise<T> {
    let log = this.eventLogs.get(runId)
    if (!log) {
      log = { events: [], byKey: new Map(), busy: 0, loaded: false }
      // 先占位再异步加载：占位期间 events 为空，真正的加载在队列内、fn 之前完成
      this.eventLogs.set(runId, log)
    }
    const entry = log
    entry.busy++
    return this.queue.run(`e:${runId}`, async () => {
      try {
        await this.loadEventLog(runId, entry)
        return await fn(entry)
      } finally {
        entry.busy--
        // 刷新最近使用顺序，再按上限淘汰不忙的旧条目
        if (this.eventLogs.get(runId) === entry) {
          this.eventLogs.delete(runId)
          this.eventLogs.set(runId, entry)
        }
        this.evictEventLogs()
      }
    })
  }

  private evictEventLogs(): void {
    if (this.eventLogs.size <= EVENT_CACHE_MAX_RUNS) return
    for (const [id, l] of this.eventLogs) {
      if (this.eventLogs.size <= EVENT_CACHE_MAX_RUNS) break
      if (l.busy === 0) this.eventLogs.delete(id)
    }
  }

  private async loadEventLog(runId: string, entry: EventLog): Promise<void> {
    if (entry.loaded) return
    const file = this.eventsFile(runId)
    let raw = ""
    try {
      raw = await fsp.readFile(file, "utf8")
    } catch (e) {
      if (!isErrno(e, "ENOENT")) throw e
    }
    const events: LocalAgentRunEventDocument[] = []
    let bad = 0
    if (raw) {
      for (const line of raw.split("\n")) {
        const t = line.trim()
        if (!t) continue
        try {
          const row = JSON.parse(t) as LocalAgentRunEventDocument
          events.push({ ...row, createdAt: toMs(row.createdAt) })
        } catch {
          bad++
        }
      }
    }
    // 尾部是写到一半的行（崩溃/断电）：用解析出的好行重写文件，否则后续追加会接在半行后面把两行都毁掉
    if (raw && (bad > 0 || !raw.endsWith("\n"))) {
      await this.put(file, events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""))
      if (bad > 0) this.log("WARN", `run ${runId} 的事件日志有 ${bad} 行损坏，已跳过`)
    }
    entry.events = events
    entry.byKey = new Map()
    for (const e of events) if (e.idempotencyKey) entry.byKey.set(e.idempotencyKey, e)
    entry.loaded = true
  }

  private buildRunEvents(): LocalAgentStoreRunEvents {
    return {
      append: async (input) => {
        await this.prepare()
        return this.withEventLog(input.runId, async (log) => {
          if (input.idempotencyKey) {
            const hit = log.byKey.get(input.idempotencyKey)
            if (hit) return { ...hit }
          }
          const seq = (log.events.length ? log.events[log.events.length - 1].seq : 0) + 1
          const doc: LocalAgentRunEventDocument = {
            runId: input.runId,
            seq,
            offset: String(seq),
            eventType: input.eventType,
            payload: input.payload ?? null,
            payloadRef: input.payloadRef ?? null,
            idempotencyKey: input.idempotencyKey ?? null,
            createdAt: Date.now(),
          }
          const line = JSON.stringify(doc)
          await this.appendTo(this.eventsFile(input.runId), line + "\n")
          // 缓存里放「落盘内容」的副本，不与调用方持有的 payload 共享引用
          const stored = JSON.parse(line) as LocalAgentRunEventDocument
          log.events.push(stored)
          if (stored.idempotencyKey) log.byKey.set(stored.idempotencyKey, stored)
          return { ...stored }
        })
      },
      list: async ({ runId, afterOffset, limit }) => {
        await this.prepare()
        return this.withEventLog(runId, async (log): Promise<LocalAgentRunEventListResult> => {
          const after = Number.parseInt(afterOffset ?? "0", 10)
          const take = limit ?? RUN_EVENT_LIST_DEFAULT_LIMIT
          const start = firstIndexAfter(log.events, Number.isFinite(after) ? after : 0)
          const rest = log.events.length - start
          const items = log.events.slice(start, start + take).map((e) => ({ ...e }))
          return {
            items,
            ...(rest > items.length && items.length > 0 ? { nextOffset: items[items.length - 1].offset } : {}),
          }
        })
      },
      delete: async ({ filter }) => {
        await this.prepare()
        const ids = filter.runIds?.length
          ? [...filter.runIds]
          : [...new Set([
              ...(await listNames(this.eventsDir())).filter((n) => n.endsWith(".ndjson")).map((n) => decodeStoreId(n.slice(0, -".ndjson".length))),
              ...this.eventLogs.keys(),
            ])]
        for (const runId of ids) {
          await this.queue.run(`e:${runId}`, async () => {
            // 原地清空再摘出缓存：排队中、已拿到旧条目的追加操作也会看到「空日志」，不会续着旧序号写回已删的文件
            const cached = this.eventLogs.get(runId)
            if (cached) {
              cached.events = []
              cached.byKey = new Map()
              cached.loaded = true
              this.eventLogs.delete(runId)
            }
            await unlinkQuiet(this.eventsFile(runId))
          })
        }
      },
    }
  }
}
