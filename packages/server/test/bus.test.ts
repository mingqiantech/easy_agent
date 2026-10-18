import { describe, it, expect } from "bun:test";
import { subscribeEvents, emitEvents, listenerCount } from "../src/bus.js";

describe("SSE 事件总线", () => {
  it("订阅→收到事件；退订后不再收、计数归零", () => {
    const got: any[] = [];
    const unsub = subscribeEvents("s1", (e) => got.push(e));
    emitEvents("s1", { type: "text", text: "hi" });
    expect(got.length).toBe(1);
    unsub();
    emitEvents("s1", { type: "text", text: "bye" });
    expect(got.length).toBe(1);
    expect(listenerCount("s1")).toBe(0);
  });

  it("按会话隔离；无监听者 emit 静默；监听者抛错不拖垮广播", () => {
    const gotA: any[] = [];
    const unsubA = subscribeEvents("a", (e) => gotA.push(e));
    subscribeEvents("a", () => {
      throw new Error("坏订阅者");
    });
    expect(() => emitEvents("nobody", { type: "x" })).not.toThrow();
    emitEvents("b", { type: "x" });
    expect(gotA.length).toBe(0);
    emitEvents("a", { type: "ok" }); // 有坏订阅者时仍应送达好订阅者
    expect(gotA.length).toBe(1);
    unsubA();
  });
});
