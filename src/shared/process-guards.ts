/**
 * daemon 的进程级自我保护：管道断了不能把自己写死，应用没了不能变成没人管的孤儿。
 *
 * 起因：用户的 Mac 上同时有两个 daemon 在线（1.4.1 的老进程 + 1.4.4 新进程）。老的那个一直没退，
 * 它的 stderr 另一头（已退出的应用）早就没了，之后每写一行日志都会 EPIPE：
 * 没有 error 监听 → uncaughtException → 处理器又往 stderr 写日志 → 再 EPIPE → 再 uncaughtException……
 * 一毫秒十几轮，事件循环被占满，飞书长连接收到的事件不再应答，飞书便按 15 秒 / 5 分钟 / 1 小时 / 6 小时重推，
 * 机器人就把几小时前答过的消息又答一遍。
 */

/** 对端已断开的写入错误：写不出去而已，不是程序 bug */
export function isBrokenPipeError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null | undefined)?.code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ECONNRESET";
}

interface ErrorListenable {
  on(event: "error", listener: (e: Error) => void): unknown;
}

/**
 * 给 stdout / stderr 装上 error 监听：管道断了的错误吞掉（日志另外写文件，不丢），
 * 其他错误照旧抛出——和没装监听时的行为一样，不吞真问题。
 */
export function guardBrokenPipe(streams: ErrorListenable[]): void {
  for (const s of streams) {
    s.on("error", (e: Error) => {
      if (isBrokenPipeError(e)) return;
      throw e;
    });
  }
}

/** 解析环境变量里的 pid：只认正整数 */
export function parsePidEnv(raw: string | undefined): number | undefined {
  if (!raw || !/^\d+$/.test(raw.trim())) return undefined;
  const pid = Number(raw.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/** 进程还在不在：发 0 号信号只探测不打扰；EPERM 说明进程在，只是没权限发信号 */
export function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export interface ParentWatchdogOptions {
  parentPid: number;
  /** 检查间隔，默认 5 秒 */
  intervalMs?: number;
  /** 判断进程存活，默认用 process.kill(pid, 0)；测试里可替换 */
  isAlive?: (pid: number) => boolean;
  /** 发现父进程没了时调用一次（调用后看门狗自行停止） */
  onOrphaned: () => void;
}

/**
 * 父进程（Electron 主进程）没了就通知调用方退出。
 * macOS / Linux 上子进程不会随父进程被强杀而自动结束，不盯着就会留下没人管的 daemon，
 * 它继续连着飞书抢事件，却已经没人收它的 stdout / stderr。
 * 返回停止函数；定时器 unref，不会拖住进程退出。
 */
export function startParentWatchdog(opts: ParentWatchdogOptions): () => void {
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const timer = setInterval(() => {
    if (isAlive(opts.parentPid)) return;
    clearInterval(timer);
    opts.onOrphaned();
  }, opts.intervalMs ?? 5000);
  timer.unref();
  return () => clearInterval(timer);
}
