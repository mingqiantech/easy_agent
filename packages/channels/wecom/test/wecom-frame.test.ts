import { describe, it, expect } from "bun:test";
import { frameToChannelMessage } from "../src/bot";

const base = {
  msgid: "m1",
  aibotid: "bot1",
  chattype: "single" as const,
  from: { userid: "Alice" },
  create_time: 1793350000,
};

describe("WeCom 帧映射", () => {
  it("单聊文本：chatId=userid，isGroup=false", () => {
    const m = frameToChannelMessage({ ...base, msgtype: "text", text: { content: "你好" } });
    expect(m.channel).toBe("wecom");
    expect(m.chatId).toBe("Alice");
    expect(m.text).toBe("你好");
    expect(m.isGroup).toBe(false);
    expect(m.timestamp).toBe(1793350000000);
  });

  it("群聊：chatId=chatid，到达即 mentioned", () => {
    const m = frameToChannelMessage({
      ...base,
      chattype: "group",
      chatid: "G123",
      msgtype: "text",
      text: { content: "帮我查下" },
    });
    expect(m.chatId).toBe("G123");
    expect(m.isGroup).toBe(true);
    expect(m.mentioned).toBe(true);
  });

  it("语音用 SDK 转写文本；图片带落盘路径说明", () => {
    const v = frameToChannelMessage({ ...base, msgtype: "voice", voice: { content: "明天天气" } });
    expect(v.text).toBe("明天天气");
    const img = frameToChannelMessage(
      { ...base, msgtype: "image", image: { url: "https://x/y" } },
      { mediaPaths: ["/tmp/wecom-1-image.jpg"] },
    );
    expect(img.text).toContain("[用户发来图片]");
    expect(img.text).toContain("/tmp/wecom-1-image.jpg");
    expect(img.attachments?.[0]?.url).toBe("file:///tmp/wecom-1-image.jpg");
  });

  it("图文混排：text 段拼接，image 段占位", () => {
    const m = frameToChannelMessage({
      ...base,
      msgtype: "mixed",
      mixed: {
        items: [
          { msgtype: "text", text: { content: "看这个" } },
          { msgtype: "image", image: { url: "u" } },
        ],
      },
    });
    expect(m.text).toContain("看这个");
    expect(m.text).toContain("[image]");
  });

  it("引用消息前缀上下文", () => {
    const m = frameToChannelMessage({
      ...base,
      msgtype: "text",
      text: { content: "就这个方案" },
      quote: { msgtype: "text", text: { content: "原方案 A" } } as any,
    });
    expect(m.text).toContain("（引用: 原方案 A）");
  });
});

describe("wecom 配置：chatAgents 固定映射（2026-10-31）", () => {
  it("schema 接受 chatAgents 且缺省空对象", async () => {
    const { ConfigSchema } = await import("@easy-agent/config/schema");
    const c = ConfigSchema.parse({
      providers: {},
      wecom: { botId: "b", secret: "s", agentId: "tech", chatAgents: { "group:123": "life" } },
    });
    expect(c.wecom!.chatAgents).toEqual({ "group:123": "life" });
    const d = ConfigSchema.parse({ providers: {}, wecom: { botId: "b", secret: "s" } });
    expect(d.wecom!.chatAgents).toEqual({});
    expect(d.wecom!.agentId).toBe("default");
  });
});
