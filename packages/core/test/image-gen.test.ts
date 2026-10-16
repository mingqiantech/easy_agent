import { describe, it, expect } from "bun:test";
import { ImageGenerator } from "../src/image-gen/index.js";

describe("ImageGenerator (offline tests)", () => {
  const gen = new ImageGenerator();

  it("validates allowed sizes", () => {
    expect(gen.validateSize("256x256")).toBe(true);
    expect(gen.validateSize("512x512")).toBe(true);
    expect(gen.validateSize("1024x1024")).toBe(true);
    expect(gen.validateSize("2048x2048")).toBe(false);
  });

  it("reports availability based on env", () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    expect(new ImageGenerator().available).toBe(false);

    process.env.OPENAI_API_KEY = "***";
    expect(new ImageGenerator().available).toBe(true);

    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  });

  it("rejects generation without API key", async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    await expect(gen.generate("a cat")).rejects.toThrow("not configured");
    if (saved) process.env.OPENAI_API_KEY = saved;
  });

  it("rejects empty prompt", async () => {
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "***";
    await expect(gen.generate("   ")).rejects.toThrow("Prompt is empty");
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  });

  it("rejects invalid size before calling API", async () => {
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "***";
    await expect(gen.generate("a cat", { size: "9999x9999" as any })).rejects.toThrow(
      "Invalid size",
    );
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  });
});
