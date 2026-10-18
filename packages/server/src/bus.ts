/** 会话事件总线：run 回调 → SSE 订阅者（内存广播，按 sessionId 隔离） */
type Ev = Record<string, unknown>;
type L = (e: Ev) => void;
const map = new Map<string, Set<L>>();

export function subscribeEvents(sessionId: string, fn: L): () => void {
  let s = map.get(sessionId);
  if (!s) {
    s = new Set();
    map.set(sessionId, s);
  }
  s.add(fn);
  return () => {
    s!.delete(fn);
    if (!s!.size) map.delete(sessionId);
  };
}

export function emitEvents(sessionId: string, e: Ev): void {
  for (const fn of map.get(sessionId) ?? []) {
    try {
      fn(e);
    } catch {
      // 单个订阅者写失败不影响其他
    }
  }
}

export function listenerCount(sessionId: string): number {
  return map.get(sessionId)?.size ?? 0;
}
