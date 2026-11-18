import * as fs from "node:fs";

/**
 * 只删「自己写的」锁文件。
 *
 * 锁文件只有一份：新 daemon 启动后会覆盖掉它，写进自己的 pid / 端口。
 * 这时旧 daemon 再退出（收到信号、父进程消失、崩溃……），如果无条件删，删掉的是新 daemon 的锁——
 * 应用从此找不到正在运行的 daemon，状态显示未运行，还可能再起一个，孤儿越攒越多。
 *
 * 锁里的 pid 不是自己：不删。读不出 pid（文件损坏或没写 pid）：当没有主人，删。
 * 返回是否真的删了。
 */
export function removeLockFileIfOwned(lockPath: string, ownerPid: number): boolean {
  let lockPid: unknown;
  try {
    lockPid = (JSON.parse(fs.readFileSync(lockPath, "utf-8")) as { pid?: unknown } | null)?.pid;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    lockPid = undefined;
  }
  if (typeof lockPid === "number" && lockPid !== ownerPid) return false;
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}
