/**
 * 输入框里「图片还在上传」时点了发送：不能先把文字发出去。
 *
 * 图片是先上传、传完才进草稿的。上传途中点发送，发出去的消息就不带图，
 * 图片随后才冒到输入框上面，用户以为图丢了。这里记下在途的上传，发送前先等它们传完。
 * 纯逻辑，不依赖 React，方便单测。
 */

/** 一批图片的上传结果：failed 是没传成的张数，error 是第一条失败原因 */
export interface UploadBatchResult {
  failed: number
  error?: string
}

export interface UploadGate {
  /** 登记一批在途的上传，返回的就是传进来的那个 Promise */
  track(batch: Promise<UploadBatchResult>): Promise<UploadBatchResult>
  /** 现在有没有上传在途 */
  readonly pending: boolean
  /** 等所有在途的上传结束并汇总结果；没有在途的上传就立刻返回 null */
  settle(): Promise<UploadBatchResult | null>
}

export function createUploadGate(): UploadGate {
  const inflight = new Set<Promise<UploadBatchResult>>()
  return {
    track(batch) {
      inflight.add(batch)
      const done = () => { inflight.delete(batch) }
      batch.then(done, done)
      return batch
    },
    get pending() {
      return inflight.size > 0
    },
    async settle() {
      if (inflight.size === 0) return null
      let failed = 0
      let error: string | undefined
      // 等的过程中可能又登记进来新的一批：一直等到一批都不剩
      while (inflight.size > 0) {
        const batches = [...inflight]
        const results = await Promise.all(
          batches.map((b) => b.catch((e: unknown): UploadBatchResult => ({ failed: 1, error: e instanceof Error ? e.message : String(e) }))),
        )
        for (const r of results) {
          failed += r.failed
          if (error === undefined) error = r.error
        }
        // 清理回调和这里的 await 谁先跑不确定：主动清掉已经等完的，免得在这里空转
        for (const b of batches) inflight.delete(b)
      }
      return error === undefined ? { failed } : { failed, error }
    },
  }
}

export type SendGateResult = { ok: true } | { ok: false; message: string }

/**
 * 发送前调用：有图片在上传就等传完。
 * 有图片没传成时不放行：用户想发的是「文字 + 图」，只发文字就是发错了；内容还留在输入框里，处理后再点一次发送。
 */
export async function waitForUploadsBeforeSend(gate: UploadGate): Promise<SendGateResult> {
  const settled = await gate.settle()
  if (!settled || settled.failed === 0) return { ok: true }
  return { ok: false, message: `消息没有发出：${settled.error ?? "图片上传失败"}。内容还在输入框里，处理后可以再发送` }
}
