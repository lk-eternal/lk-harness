import { CronExpressionParser } from "cron-parser";
import * as fs from "node:fs";
import * as path from "node:path";
import { readScheduledTasksFile, type ScheduledTask } from "./shared/scheduled-task.js";

export type { ScheduledTask };

const APP_DATA_DIR = process.env.APP_DATA_DIR || "";
const TASKS_FILE = path.join(APP_DATA_DIR, "scheduled-tasks.json");
/** 轮询间隔：不依赖单次 setTimeout 链，避免锁屏/会话节流导致整点永不触发 */
const WATCHDOG_MS = 5_000;
/** 仅接受计划触发时刻距今不超过此时长（短时卡顿/锁屏补救）；睡眠过久唤醒后不补跑过期槽位 */
const CATCHUP_MAX_MS = 30 * 60 * 1000;
/** 单任务单次 tick 内最多向前迭代次数 */
const MAX_FIRES_PER_TICK = 10_000;

let scheduledTasksSnapshot: ScheduledTask[] = [];
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let lastWatchdogMs = 0;
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

function collectDueCronFires(expression: string, rangeStartExclusive: Date, rangeEndInclusive: Date): Date[] {
  const out: Date[] = [];
  const endMs = rangeEndInclusive.getTime();
  // 扫描窗口封顶 CATCHUP_MAX_MS：更早的触发点本就会被 catchup 过滤丢弃；
  // 避免长休眠唤醒后窗口过大、每秒迭代被 MAX_FIRES_PER_TICK 截断而漏扫近期槽位
  const startMs = Math.max(rangeStartExclusive.getTime(), endMs - CATCHUP_MAX_MS);
  if (endMs <= startMs) {
    return out;
  }
  let cursor = new Date(startMs + 1);
  for (let i = 0; i < MAX_FIRES_PER_TICK; i++) {
    let interval;
    try {
      interval = CronExpressionParser.parse(expression, { currentDate: cursor });
    } catch {
      return out;
    }
    const next = interval.next().toDate();
    const nt = next.getTime();
    if (nt > endMs) {
      break;
    }
    if (nt > startMs) {
      out.push(next);
    }
    cursor = new Date(nt + 1000);
  }
  return out;
}

function stopWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  lastWatchdogMs = 0;
}
interface SchedulerCallbacks {
  enqueue: (task: ScheduledTask, content: string) => void;
  launchIndependent?: (task: ScheduledTask, content: string) => void;
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
  lastWatchdogMs = nowMs;
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
      cb.enqueue(task, message);
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
  if (!fs.existsSync(APP_DATA_DIR)) {
    try {
      fs.mkdirSync(APP_DATA_DIR, { recursive: true });
    } catch { /* ignore */ }
  }
  try {
    fileWatcher = fs.watch(APP_DATA_DIR, (_eventType, filename) => {
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
        reloadTasks(cb);
      }, 500);
    });
    fileWatcher.on("error", () => { /* ignore */ });
  } catch (e) {
    log(`文件监听启动失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function startDaemonScheduledTasks(
  enqueue: (task: ScheduledTask, content: string) => void,
  launchIndependent?: (task: ScheduledTask, content: string) => void,
): void {
  schedulerStopped = false;
  const cb: SchedulerCallbacks = { enqueue, launchIndependent };
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

