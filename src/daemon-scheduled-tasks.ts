import { CronExpressionParser } from "cron-parser";
import * as fs from "node:fs";
import * as path from "node:path";
import { readScheduledTasksFile, type ScheduledTask } from "./shared/scheduled-task.js";
import { configDir } from "./shared/data-paths.js";

export type { ScheduledTask };

const APP_DATA_DIR = process.env.APP_DATA_DIR || "";
// 与 Electron 侧 cron-scheduler / daemon.ts:3731 保持一致：任务文件在 config/ 下
const TASKS_DIR = configDir(APP_DATA_DIR || ".");
const TASKS_FILE = path.join(TASKS_DIR, "scheduled-tasks.json");
/** 轮询间隔：不依赖单次 setTimeout 链，避免锁屏/会话节流导致整点永不触发 */
const WATCHDOG_MS = 5_000;
/** 仅接受计划触发时刻距今不超过此时长（短时卡顿/锁屏补救）；睡眠过久唤醒后不补跑过期槽位 */
const CATCHUP_MAX_MS = 30 * 60 * 1000;
/** 单任务单次 tick 内最多向前迭代次数 */
const MAX_FIRES_PER_TICK = 10_000;
/** 查「错过」最多往回看多久：再久的空档逐点枚举没有意义，也会拖慢启动 */
const MISSED_LOOKBACK_MAX_MS = 7 * 24 * 60 * 60 * 1000;

let scheduledTasksSnapshot: ScheduledTask[] = [];
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let lastWatchdogMs = 0;
/** 上一次确认调度器还活着的时间；0 = 不知道。启动时由调用方给上次进程留下的，之后每个 tick 刷新 */
let lastSeenMs = 0;
const firedSlotKeys = new Set<string>();
let fileWatcher: fs.FSWatcher | null = null;
let fileDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let schedulerStopped = false;
let logFn: ((msg: string) => void) | null = null;

export function setDaemonSchedulerLogger(fn: (msg: string) => void): void {
  logFn = fn;
}

function log(msg: string): void {
  if (logFn) {
    logFn(`[定时任务] ${msg}`);
  }
}

function readTasksFromFile(): ScheduledTask[] {
  try {
    return readScheduledTasksFile(TASKS_FILE);
  } catch (e) {
    log(`读取任务文件失败，保留上次快照: ${e instanceof Error ? e.message : String(e)}`);
    return scheduledTasksSnapshot;
  }
}

function isValidCron(expression: string): boolean {
  const trimmed = expression.trim();
  if (!trimmed) {
    return false;
  }
  try {
    CronExpressionParser.parse(trimmed, { currentDate: new Date() });
    return true;
  } catch {
    return false;
  }
}

/** cron 在 (startExclusiveMs, endInclusiveMs] 内的计划触发点（毫秒时间戳，升序） */
export function collectCronSlots(expression: string, startExclusiveMs: number, endInclusiveMs: number): number[] {
  const out: number[] = [];
  if (endInclusiveMs <= startExclusiveMs) {
    return out;
  }
  let cursor = new Date(startExclusiveMs + 1);
  for (let i = 0; i < MAX_FIRES_PER_TICK; i++) {
    let interval;
    try {
      interval = CronExpressionParser.parse(expression, { currentDate: cursor });
    } catch {
      return out;
    }
    const nt = interval.next().toDate().getTime();
    if (nt > endInclusiveMs) {
      break;
    }
    if (nt > startExclusiveMs) {
      out.push(nt);
    }
    cursor = new Date(nt + 1000);
  }
  return out;
}

function collectDueCronFires(expression: string, rangeStartExclusive: Date, rangeEndInclusive: Date): Date[] {
  const endMs = rangeEndInclusive.getTime();
  // 扫描窗口封顶 CATCHUP_MAX_MS：更早的触发点本就会被 catchup 过滤丢弃；
  // 避免长休眠唤醒后窗口过大、每秒迭代被 MAX_FIRES_PER_TICK 截断而漏扫近期槽位
  const startMs = Math.max(rangeStartExclusive.getTime(), endMs - CATCHUP_MAX_MS);
  return collectCronSlots(expression, startMs, endMs).map((ms) => new Date(ms));
}

/**
 * 本该触发、却没有触发的计划时间（只查，不补跑）。
 * seenMs = 上一次确认调度器还活着的时间（0 = 不知道，不查）；prevMs / nowMs = 这一轮扫描窗口的两端。
 * 两段都算错过：窗口里早于 CATCHUP_MAX_MS 的触发点会被丢弃；窗口之前的 (seenMs, prevMs] 根本没扫过（关机 / 应用没开）。
 * notBeforeMs：任务创建之前的触发点不算它错过的。
 * 正常 tick 里 seenMs 就是 prevMs，两段都是空的，不会去解析 cron。
 */
export function findMissedSlots(
  expression: string,
  seenMs: number,
  prevMs: number,
  nowMs: number,
  notBeforeMs = 0,
): number[] {
  if (seenMs <= 0) {
    return [];
  }
  const fromMs = Math.max(seenMs, nowMs - MISSED_LOOKBACK_MAX_MS, notBeforeMs);
  const toMs = Math.max(prevMs, nowMs - CATCHUP_MAX_MS);
  return collectCronSlots(expression, fromMs, toMs);
}

function stopWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  lastWatchdogMs = 0;
}
interface SchedulerCallbacks {
  /** fireAt = 这次触发的计划时间（毫秒时间戳） */
  enqueue: (task: ScheduledTask, content: string, fireAt: number) => void;
  /** slots = 这个任务本该触发却没触发的计划时间（升序） */
  onMissed?: (task: ScheduledTask, slots: number[]) => void;
}

/** 按时间窗口扫描应触发点；仅接受距今不超过 CATCHUP_MAX_MS 的槽位（过时即丢弃，避免睡眠唤醒后执行已失效任务）。 */
function runWatchdogTick(cb: SchedulerCallbacks): void {
  if (scheduledTasksSnapshot.length === 0) {
    return;
  }
  const nowMs = Date.now();
  const prevMs = lastWatchdogMs === 0 ? nowMs - WATCHDOG_MS : lastWatchdogMs;
  const rangeStartExclusive = new Date(prevMs);
  const rangeEndInclusive = new Date(nowMs);
  const seenMs = lastSeenMs;
  lastWatchdogMs = nowMs;
  lastSeenMs = nowMs;
  for (const task of scheduledTasksSnapshot) {
    if (!task.enabled) {
      continue;
    }
    const expr = task.cron.trim();
    let fires: Date[];
    try {
      fires = collectDueCronFires(expr, rangeStartExclusive, rangeEndInclusive);
    } catch (e) {
      log(`解析 cron 失败: ${task.name} — ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const missed = findMissedSlots(expr, seenMs, prevMs, nowMs, task.createdAt);
    if (missed.length > 0) {
      log(`错过 ${missed.length} 次触发: ${task.name}（电脑休眠、关机或应用没开）`);
      cb.onMissed?.(task, missed);
    }
    for (const fireAt of fires) {
      if (nowMs - fireAt.getTime() > CATCHUP_MAX_MS) {
        continue;
      }
      const slotKey = `${task.id}:${fireAt.getTime()}`;
      if (firedSlotKeys.has(slotKey)) {
        continue;
      }
      firedSlotKeys.add(slotKey);
      if (firedSlotKeys.size > 2_000) {
        firedSlotKeys.clear();
      }
      const nowStr = fireAt.toLocaleString("zh-CN");
      const message = `[定时任务: ${task.name}] (触发时间: ${nowStr})\n\n${task.content}`;
      log(`触发: ${task.name}${task.independent ? " [独立运行]" : ""}`);
      // 独立/非独立统一入队：失败重试走同一套队列调度，不再直塞 Prompt
      cb.enqueue(task, message, fireAt.getTime());
    }
  }
}

function reloadTasks(cb: SchedulerCallbacks): void {
  stopWatchdog();
  scheduledTasksSnapshot = [];
  const tasks = readTasksFromFile();
  const enabled = tasks.filter((t) => t.enabled);
  if (enabled.length === 0) {
    log(`无活跃定时任务 (共 ${tasks.length} 个)`);
    return;
  }
  for (const task of enabled) {
    if (!isValidCron(task.cron)) {
      log(`无效的 cron 表达式: "${task.cron}" (任务: ${task.name})`);
      continue;
    }
    scheduledTasksSnapshot.push(task);
    log(`已注册: ${task.name} (${task.cron})${task.independent ? " [独立]" : ""}`);
  }
  if (scheduledTasksSnapshot.length === 0) {
    log("无有效定时任务（表达式均无效）");
    return;
  }
  lastWatchdogMs = 0;
  watchdogTimer = setInterval(() => {
    runWatchdogTick(cb);
  }, WATCHDOG_MS);
  runWatchdogTick(cb);
}

function stopFileWatcher(): void {
  if (fileDebounceTimer) {
    clearTimeout(fileDebounceTimer);
    fileDebounceTimer = null;
  }
  if (fileWatcher) {
    fileWatcher.close();
    fileWatcher = null;
  }
}

function startFileWatcher(cb: SchedulerCallbacks): void {
  stopFileWatcher();
  if (!APP_DATA_DIR) return;
  if (!fs.existsSync(TASKS_DIR)) {
    try {
      fs.mkdirSync(TASKS_DIR, { recursive: true });
    } catch { /* ignore */ }
  }
  try {
    fileWatcher = fs.watch(TASKS_DIR, (_eventType, filename) => {
      if (filename !== "scheduled-tasks.json") {
        return;
      }
      if (fileDebounceTimer) {
        clearTimeout(fileDebounceTimer);
      }
      fileDebounceTimer = setTimeout(() => {
        fileDebounceTimer = null;
        if (schedulerStopped) return;
        log("检测到定时任务配置文件变化，重新加载...");
        // 任务可能是刚建的 / 刚启用的，之前没人盯着它：不能把「上次 tick 以来」的空档算成它错过的
        lastSeenMs = Date.now();
        reloadTasks(cb);
      }, 500);
    });
    fileWatcher.on("error", () => { /* ignore */ });
  } catch (e) {
    log(`文件监听启动失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface SchedulerStartOptions {
  /** 上一个 daemon 进程最后确认还活着的时间（毫秒）；据此找出关机 / 应用没开期间错过的触发点。不给就不查 */
  lastAliveAt?: number;
  onMissed?: SchedulerCallbacks["onMissed"];
}

export function startDaemonScheduledTasks(
  enqueue: SchedulerCallbacks["enqueue"],
  options: SchedulerStartOptions = {},
): void {
  schedulerStopped = false;
  lastSeenMs = options.lastAliveAt ?? 0;
  const cb: SchedulerCallbacks = { enqueue, onMissed: options.onMissed };
  reloadTasks(cb);
  startFileWatcher(cb);
  log(`调度器已启动 (${scheduledTasksSnapshot.length} 个活跃任务)`);
}

export function stopDaemonScheduledTasks(): void {
  schedulerStopped = true;
  const count = scheduledTasksSnapshot.length;
  stopWatchdog();
  stopFileWatcher();
  scheduledTasksSnapshot = [];
  firedSlotKeys.clear();
  if (count > 0) {
    log(`调度器已停止 (${count} 个任务已停止)`);
  }
}

