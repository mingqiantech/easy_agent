import { LLMClient } from "./client.js";
const llm = new LLMClient({
  providers: {
    openai: {
      apiKey: process.env.OPENAI_API_KEY!,
      baseUrl: process.env.OPEMAI_BASE_URL!,
    },
    // anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },
  },
});
async function main() {
  console.log("Testing LLM Client \n");
  const response = await llm.generate({
    model: "openai/qwen3.8-flash",
    messages: [{ role: "user", content: "用一句话解释什么是 TypeScript" }],
    generation: { maxTokens: 2000 },
  });
  console.log("Response:", response.content);
  console.log("Usage:", response.usage);
}
main().catch(console.error);
