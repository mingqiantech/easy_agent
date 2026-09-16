import { LLMClient } from "./client.js";
const llm = new LLMClient({
  providers: {
    openai: { apiKey: process.env.OPEMAI_API_KEY! },
    // anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },
  },
});
async function main() {
  console.log("Testing LLM Client \n");
  const response = await llm.generate({
    model: "openai/gpt-4o-mini",
    messages: [{ role: "user", content: "用一句话解释什么是 TypeScript" }],
    generation: { maxTokens: 100 },
  });
  console.log("Response:", response.content);
  console.log("Usage:", response.usage);
}
main().catch(console.error);
