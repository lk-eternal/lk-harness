/**
 * 增量解析 SSE 文本流：从缓冲区里取出所有已完整的事件的 data 内容，返回剩余的半截数据。
 * 以冒号开头的注释行（心跳 `: ping`）不产生事件。
 */
export function drainSseFrames(buffer: string): { payloads: string[]; rest: string } {
  const parts = buffer.replace(/\r\n/g, "\n").split("\n\n")
  const rest = parts.pop() ?? ""
  const payloads: string[] = []
  for (const frame of parts) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n")
    if (data) payloads.push(data)
  }
  return { payloads, rest }
}
