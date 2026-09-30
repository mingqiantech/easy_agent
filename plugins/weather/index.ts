import { z } from "zod";
import type { Plugin } from "@easy-agent/core/plugin/types";

const plugin: Plugin = {
  name: "weather",
  version: "1.0.0",
  description: "查询天气信息",

  registerTools() {
    return [
      {
        name: "weather",
        description: "查询指定城市的当前天气 ",
        inputSchema: z.object({
          city: z.string().describe("城市名（如 Beijing, Tokyo）"),
        }),
        async execute(input: any) {
          try {
            const res = await fetch(
              `https://wttr.in/${encodeURIComponent(input.city)}?format=j1`,
            );
            const data = (await res.json()) as any;
            const current = data.current_condition?.[0];
            if (!current) return { error: "No weather data" };
            return {
              city: input.city,
              temp: `${current.temp_C}°C`,
              feels: `${current.FeelsLikeC}°C`,
              humidity: `${current.humidity}%`,
              description: current.weatherDesc?.[0]?.value ?? "unknown",
              wind: `${current.windspeedKmph} km/h`,
            };
          } catch (e: any) {
            return { error: e.message };
          }
        },
      },
    ];
  },
};

export default plugin;
