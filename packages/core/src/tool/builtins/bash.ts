import { z } from "zod";
import { spawn } from "node:child_process";
import path from "node:path";
import type { Tool, ToolContext } from "../types.js";

const MAX_OUTPUT = 50 * 1024;
export const bashTool:Tool ={
    name:"bash",
    description:"执行shell命令。返回 exitCode/stdout/stderr。超时 30s，输出截断 50KB。"
    inputSchema:z.object({
        command:z.string().describe("shell 命令"),
        workdir:z.string().optional(),
        timeout:z.number().optional().describe("超时秒数"),
    }),
}