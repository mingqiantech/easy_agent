import type { Tool, ToolContext } from "../tool/types.js";

export interface PluginApi {
  registerTool(tool: Tool): void;
  registerCronJob(job: any): void;
  getConfig(): any;
  getLogger(): {
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
  };
}

export interface Plugin {
  name: string;
  version: string;
  description?: string;
  onLoad?(api: PluginApi): Promise<void> | void;
  onUnload?(): Promise<void> | void;
  registerTools?(api: PluginApi): Tool[];
}
