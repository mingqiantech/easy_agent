import { LLMClient } from "./client.js";
const llm = new LLMClient({
  providers: {
    openai: {
      apiKey: process.env.OPENAI_API_KEY!,
      baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    },
    // anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },
  },
});
async function main() {
  console.log("Testing LLM Client \n");
  const response = await llm.generate({
    model: "openai/glm-5.3",
    messages: [{ role: "user", content: "用一句话解释什么是 TypeScript" }],
    generation: { maxTokens: 2000 },
  });
  console.log("Response:", response.content);
  console.log("Usage:", response.usage);
}
main().catch(console.error);
