/** 临时会话的工作目录文件夹前缀：<userData>/workspaces/temp_<毫秒时间戳> */
export const TEMP_WORKSPACE_PREFIX = "temp_";

const TEMP_WORKSPACE_RE = new RegExp(`(?:^|[\\\\/])workspaces[\\\\/]${TEMP_WORKSPACE_PREFIX}(\\d+)[\\\\/]*$`);

/** 是否是应用建的临时会话目录（纯字符串判断，渲染进程也能用） */
export function isTempChatWorkspace(dir: string | undefined): boolean {
  return !!dir && TEMP_WORKSPACE_RE.test(dir);
}

/** 临时目录的创建时间（取自目录名里的时间戳），不是临时目录时为 undefined */
export function tempWorkspaceCreatedAt(dir: string | undefined): number | undefined {
  const m = dir ? TEMP_WORKSPACE_RE.exec(dir) : null;
  return m ? Number(m[1]) : undefined;
}
