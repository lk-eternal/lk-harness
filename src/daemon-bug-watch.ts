// 项目缺陷监控：定期查飞书项目里「关联本项目需求」的缺陷，发现新增的就投给项目会话、并在项目群里提一句。
// 这里是编排：查谁、查不查、去重、投递成功才记账。所有外部动作（查飞书项目 / 写会话队列 / 发群消息 / 读写记录）
// 都从 deps 注入，daemon 接真实实现，测试接替身。
//
// 约定：
//  - 没有任何项目开着监控 → 不调用飞书项目 CLI（零成本）。
//  - 没有新缺陷 → 不唤醒任何 AI（只在发现新缺陷时才投递）。
//  - 第一次查询只建基线，已有的缺陷不当新缺陷刷屏。
//  - 投给项目会话失败（还没有会话 / 写队列失败）不记账，下一轮重试；群通知是尽力而为，失败不影响记账。
//  - 查询失败（CLI 没登录 / 超时 / 返回看不懂的东西）不更新记录，更不会拿「空结果」当基线。

import type { Project } from "./shared/project-types.js";
import {
  BUG_WATCH_SPACE,
  bugWatchUnsupportedReason,
  buildBugQuery,
  diffBugs,
  formatBugsForSession,
  formatBugsGroupNotice,
  looksLikeBugQueryResult,
  parseBugRows,
  parseWatchableStoryUrl,
  type BugRecord,
  type BugWatchState,
} from "./shared/project-bug-watch.js";

export const BUG_WATCH_INTERVAL_MS = 10 * 60_000;
/** daemon 启动后多久做第一轮：建好基线，之后新增的缺陷才算新 */
export const BUG_WATCH_FIRST_DELAY_MS = 30_000;

export type WatchProject = Pick<Project, "id" | "name" | "status" | "storyUrl" | "watchBugs">;

export interface BugWatchDeps {
  now(): number;
  listProjects(): WatchProject[];
  authenticated(): Promise<boolean>;
  fetchStoryName(storyId: string): Promise<string | undefined>;
  /** 查询失败 / 结果看不懂时抛错（不要返回空数组冒充「没有缺陷」） */
  fetchBugs(storyName: string): Promise<BugRecord[]>;
  loadState(): BugWatchState;
  saveState(state: BugWatchState): void;
  deliverToSession(project: WatchProject, text: string): { ok: true } | { ok: false; error: string };
  notifyGroup(project: WatchProject, text: string): Promise<void>;
  log(level: "INFO" | "WARN", msg: string): void;
}

export type BugWatchResult = "baseline" | "new" | "unchanged" | "skipped" | "error";

export interface BugWatchOutcome {
  projectId: string;
  name: string;
  result: BugWatchResult;
  detail: string;
  /** result=new 时本次新增的缺陷数 */
  fresh?: number;
}

export interface BugWatchCycleResult {
  ran: boolean;
  /** ran=false 的原因 */
  reason?: string;
  projects: BugWatchOutcome[];
}

/** 一轮：对每个开着监控的活跃项目查一次 */
export async function runBugWatchCycle(deps: BugWatchDeps, opts: { projectId?: string } = {}): Promise<BugWatchCycleResult> {
  const all = deps.listProjects();
  const outcomes: BugWatchOutcome[] = [];
  const candidates: Array<{ project: WatchProject; storyId: string }> = [];

  for (const p of all) {
    if (opts.projectId && p.id !== opts.projectId) continue;
    if (p.watchBugs !== true) continue;
    const skip = (detail: string) => outcomes.push({ projectId: p.id, name: p.name, result: "skipped", detail });
    if (p.status !== "active") { skip(p.status === "paused" ? "项目已暂停" : "项目已完成"); continue; }
    const story = parseWatchableStoryUrl(p.storyUrl);
    if (!story) { skip(bugWatchUnsupportedReason(p.storyUrl) ?? "需求链接不支持"); continue; }
    candidates.push({ project: p, storyId: story.storyId });
  }

  // 已删除的项目：记录不再有用（只在查全量时清，按单个项目手动查时不动）
  if (!opts.projectId) pruneState(deps, new Set(all.map((p) => p.id)));

  if (candidates.length === 0) return { ran: false, reason: "没有需要监控的项目", projects: outcomes };

  if (!(await deps.authenticated())) {
    deps.log("WARN", "[缺陷监控] 飞书项目 CLI 未登录或不可用，本轮跳过");
    return { ran: false, reason: "飞书项目 CLI 未登录或不可用", projects: outcomes };
  }

  const state = deps.loadState();
  for (const { project, storyId } of candidates) {
    const base = { projectId: project.id, name: project.name };
    try {
      outcomes.push({ ...base, ...(await checkProject(deps, state, project, storyId)) });
    } catch (e: unknown) {
      const error = e instanceof Error ? e.message : String(e);
      deps.log("WARN", `[缺陷监控] 「${project.name}」查询失败: ${error}`);
      outcomes.push({ ...base, result: "error", detail: error });
    }
  }
  return { ran: true, projects: outcomes };
}

function pruneState(deps: BugWatchDeps, liveIds: Set<string>): void {
  const state = deps.loadState();
  const stale = Object.keys(state).filter((id) => !liveIds.has(id));
  if (stale.length === 0) return;
  for (const id of stale) delete state[id];
  try {
    deps.saveState(state);
  } catch (e: unknown) {
    deps.log("WARN", `[缺陷监控] 清理已删除项目的记录失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function checkProject(
  deps: BugWatchDeps,
  state: BugWatchState,
  project: WatchProject,
  storyId: string,
): Promise<Pick<BugWatchOutcome, "result" | "detail" | "fresh">> {
  const prev = state[project.id];
  const cached = prev && prev.storyId === storyId ? prev.storyName : undefined;
  const storyName = cached ?? (await deps.fetchStoryName(storyId));
  if (!storyName) return { result: "error", detail: `取不到需求 ${storyId} 的名称（需求不存在，或没有权限）` };
  if (!buildBugQuery(storyName)) {
    return { result: "skipped", detail: "需求名称含引号 / 反斜杠 / 换行，没法安全地拼进查询，不监控" };
  }

  const bugs = await deps.fetchBugs(storyName);
  const diff = diffBugs(prev, storyId, storyName, bugs, deps.now());

  if (diff.fresh.length > 0) {
    const sent = deps.deliverToSession(project, formatBugsForSession(project.name, diff.fresh, new Date(deps.now())));
    if (!sent.ok) {
      deps.log("WARN", `[缺陷监控] 「${project.name}」发现 ${diff.fresh.length} 个新缺陷，但没能投给项目会话（${sent.error}），下一轮重试`);
      return { result: "error", detail: `发现 ${diff.fresh.length} 个新缺陷，但没能投给项目会话：${sent.error}`, fresh: diff.fresh.length };
    }
    state[project.id] = diff.next;
    deps.saveState(state);
    deps.log("INFO", `[缺陷监控] 「${project.name}」新增 ${diff.fresh.length} 个缺陷，已投给项目会话`);
    try {
      await deps.notifyGroup(project, formatBugsGroupNotice(project.name, diff.fresh));
    } catch (e: unknown) {
      deps.log("WARN", `[缺陷监控] 「${project.name}」群通知失败（已投给项目会话，不影响记账）: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { result: "new", detail: `新增 ${diff.fresh.length} 个缺陷`, fresh: diff.fresh.length };
  }

  state[project.id] = diff.next;
  deps.saveState(state);
  if (diff.baseline) {
    deps.log("INFO", `[缺陷监控] 「${project.name}」建立基线：当前已有 ${bugs.length} 个缺陷，之后新增的才会通知`);
    return { result: "baseline", detail: `已建立基线（当前 ${bugs.length} 个缺陷），之后新增的才会通知` };
  }
  return { result: "unchanged", detail: `没有新缺陷（共 ${bugs.length} 个）` };
}

// ── 定时器 ─────────────────────────────────────────────

export interface BugWatcher {
  start(): void;
  stop(): void;
  /** 立刻跑一轮；上一轮还没跑完就不重入 */
  runNow(opts?: { projectId?: string }): Promise<BugWatchCycleResult>;
}

export function createBugWatcher(
  deps: BugWatchDeps,
  timing: { intervalMs?: number; firstDelayMs?: number } = {},
): BugWatcher {
  const intervalMs = timing.intervalMs ?? BUG_WATCH_INTERVAL_MS;
  const firstDelayMs = timing.firstDelayMs ?? BUG_WATCH_FIRST_DELAY_MS;
  let running = false;
  let first: ReturnType<typeof setTimeout> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const runNow = async (opts: { projectId?: string } = {}): Promise<BugWatchCycleResult> => {
    if (running) return { ran: false, reason: "上一轮还没结束", projects: [] };
    running = true;
    try {
      return await runBugWatchCycle(deps, opts);
    } catch (e: unknown) {
      const error = e instanceof Error ? e.message : String(e);
      deps.log("WARN", `[缺陷监控] 本轮异常: ${error}`);
      return { ran: false, reason: error, projects: [] };
    } finally {
      running = false;
    }
  };

  return {
    start() {
      if (timer || first) return;
      first = setTimeout(() => { first = undefined; void runNow(); }, firstDelayMs);
      first.unref?.();
      timer = setInterval(() => { void runNow(); }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (first) clearTimeout(first);
      if (timer) clearInterval(timer);
      first = undefined;
      timer = undefined;
    },
    runNow,
  };
}

// ── 飞书项目 CLI 取数 ──────────────────────────────────

type RunMeegle = (args: string[], timeoutMs: number) => Promise<unknown>;

/** 用注入的 runMeegle 取需求名称 / 缺陷列表（测试里换成替身，不起真实 CLI） */
export function createMeegleBugSource(run: RunMeegle): Pick<BugWatchDeps, "fetchStoryName" | "fetchBugs"> {
  return {
    async fetchStoryName(storyId) {
      const raw = (await run([
        "workitem", "get",
        "--project-key", BUG_WATCH_SPACE,
        "--work-item-id", storyId,
        "--fields", "wiki",
        "-o", "json",
      ], 12_000)) as { work_item_attribute?: { work_item_name?: string } } | null;
      return raw?.work_item_attribute?.work_item_name?.trim() || undefined;
    },
    async fetchBugs(storyName) {
      const mql = buildBugQuery(storyName);
      if (!mql) throw new Error("需求名称不能安全地拼进查询");
      const raw = await run([
        "workitem", "query",
        "--project-key", BUG_WATCH_SPACE,
        "-P", JSON.stringify({ mql }),
        "-o", "json",
      ], 15_000);
      if (!looksLikeBugQueryResult(raw)) throw new Error("飞书项目返回了无法识别的结果");
      return parseBugRows(raw);
    },
  };
}
