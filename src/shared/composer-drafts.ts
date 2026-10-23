/**
 * 输入框草稿：按会话分开存放「还没发送的文字 + 待发送图片」。
 *
 * 输入框只有一个，但草稿属于会话：在 A 会话里敲了一半的字，切到（或新建）B 会话时输入框应该是 B 自己的内容，
 * 切回 A 时再原样回来。草稿集中放在这个 store 里（键是会话 id），组件只管按当前会话的键读写，
 * 这样切会话不需要在组件里做「存旧的、取新的」，图片异步上传完成时也能准确落到发起它的那个会话。
 *
 * 不依赖 React / DOM，桌面端和手机端共用。
 */

export interface DraftImage {
  /** 已落盘的路径，随消息发给 Agent，也是图片的唯一标识 */
  path: string
}

export interface ComposerDraft<I extends DraftImage = DraftImage> {
  text: string
  images: I[]
}

export interface DraftStoreOptions<I extends DraftImage> {
  /** 图片离开草稿（被移除、发送后清空、草稿被丢弃）时调用，用来释放预览用的 blob URL 等资源 */
  onRemoveImage?: (image: I) => void
}

export interface DraftStore<I extends DraftImage = DraftImage> {
  /** 没有草稿时返回同一个空对象，所以可以直接当 useSyncExternalStore 的快照（引用稳定） */
  get(key: string | null): ComposerDraft<I>
  /** 改写某个会话的草稿；key 为空（还没选中会话）时什么都不做。结果为空草稿时直接删掉该条记录 */
  update(key: string | null, fn: (draft: ComposerDraft<I>) => ComposerDraft<I>): void
  /** 丢弃某个会话的草稿（发送后清空、会话被删） */
  discard(key: string | null): void
  subscribe(listener: () => void): () => void
}

export function createDraftStore<I extends DraftImage = DraftImage>(options: DraftStoreOptions<I> = {}): DraftStore<I> {
  const empty: ComposerDraft<I> = Object.freeze({ text: "", images: Object.freeze([]) as unknown as I[] })
  const drafts = new Map<string, ComposerDraft<I>>()
  const listeners = new Set<() => void>()

  const emit = () => {
    for (const l of [...listeners]) l()
  }

  const releaseRemoved = (before: ComposerDraft<I>, after: ComposerDraft<I>) => {
    if (!options.onRemoveImage || before.images.length === 0) return
    const kept = new Set(after.images.map((i) => i.path))
    for (const img of before.images) {
      if (!kept.has(img.path)) options.onRemoveImage(img)
    }
  }

  const get = (key: string | null): ComposerDraft<I> => (key === null ? empty : (drafts.get(key) ?? empty))

  return {
    get,
    update(key, fn) {
      if (key === null) return
      const before = get(key)
      const after = fn(before)
      if (after === before) return
      if (after.text === before.text && after.images.length === before.images.length && after.images.every((i, n) => i === before.images[n])) return
      if (after.text === "" && after.images.length === 0) drafts.delete(key)
      else drafts.set(key, after)
      releaseRemoved(before, after)
      emit()
    },
    discard(key) {
      if (key === null) return
      const before = drafts.get(key)
      if (!before) return
      drafts.delete(key)
      releaseRemoved(before, empty)
      emit()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
