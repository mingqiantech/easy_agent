import fs from "node:fs";
import { loadConfig } from "@easy-agent/config/loader";
const config = loadConfig();
const prov = (config.providers as any)["qwencloud-token-plan"];
const longSys = "你是TTL探测助手第二版。" + "保持简洁回答。".repeat(300);
async function call(tag: string) {
  const body = { model: "qwen3.8-flash", max_tokens: 16, system: [{ type: "text", text: longSys, cache_control: { type: "ephemeral", ttl: "1h" } }], messages: [{ role: "user", content: "你好" }] };
  const res = await fetch(prov.baseUrl.replace(/\/+$/, "") + "/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: ("Be"+"arer ") + prov.apiKey, "x-api-key": prov.apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  const j: any = await res.json();
  const line = `${tag} ${res.status} usage: ${JSON.stringify(j.usage ?? j.error ?? j)}`;
  fs.appendFileSync("/tmp/ttl_probe.log", line + "\n");
}
await call("[write ttl1h]");
await call("[read immediate]");
