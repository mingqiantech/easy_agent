import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolContext } from "../types.js";

interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "done";
}

function todoFile(ctx: ToolContext) {
  return path.join(ctx.workDir, ".easy-agent", "todo.json");
}

async function loadTodos(ctx: ToolContext): Promise<TodoItem[]> {
  try {
    const raw = await fs.readFile(todoFile(ctx), "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data.todos) ? data.todos : [];
  } catch {
    return [];
  }
}

async function saveTodos(ctx: ToolContext, todos: TodoItem[]) {
  const file = todoFile(ctx);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ todos }, null, 2), "utf-8");
}

export const todoTool: Tool = {
  name: "todo",
  description:
    "维护当前项目的任务清单（多步工作规划）。action: list 查看 / add 新增 / update 改内容或状态 / remove 删除。状态: pending | in_progress | done。",
  inputSchema: z.object({
    action: z.enum(["list", "add", "update", "remove"]),
    content: z.string().optional().describe("add 时的任务内容"),
    id: z.string().optional().describe("update/remove 时的任务 id"),
    status: z.enum(["pending", "in_progress", "done"]).optional(),
  }),
  async execute(input: any, ctx: ToolContext) {
    const todos = await loadTodos(ctx);
    switch (input.action) {
      case "list":
        return { todos, count: todos.length };
      case "add": {
        if (!input.content) return { error: "add 需要 content" };
        const item: TodoItem = {
          id: String(Date.now()),
          content: input.content,
          status: "pending",
        };
        todos.push(item);
        await saveTodos(ctx, todos);
        return { added: item };
      }
      case "update": {
        const item = todos.find((t) => t.id === input.id);
        if (!item) return { error: `未找到 id=${input.id}` };
        if (input.content) item.content = input.content;
        if (input.status) item.status = input.status;
        await saveTodos(ctx, todos);
        return { updated: item };
      }
      case "remove": {
        const idx = todos.findIndex((t) => t.id === input.id);
        if (idx === -1) return { error: `未找到 id=${input.id}` };
        const [removed] = todos.splice(idx, 1);
        await saveTodos(ctx, todos);
        return { removed };
      }
      default:
        return { error: `未知 action: ${input.action}` };
    }
  },
};
