import { openMobilePreview, requestMobilePreviewDownloadUrl } from "./api"

/**
 * 项目成果的下载链接。成果是 AI 在项目文件夹里生成的，不一定在聊天记录里出现过，
 * 按路径换下载票据会被拒（电脑端只认聊天里引用过的文件）；先「打开预览」让电脑端按项目目录校验，
 * 再凭预览令牌换票据——和预览页里的「下载」同一条路。
 */
export async function projectArtifactDownloadUrl(baseUrl: string, token: string, sessionKey: string, filePath: string): Promise<string> {
  const opened = await openMobilePreview(baseUrl, token, sessionKey, filePath)
  if (!opened.ok) throw new Error(opened.error ?? "无法下载这个文件")
  return await requestMobilePreviewDownloadUrl(baseUrl, token, opened.token)
}
