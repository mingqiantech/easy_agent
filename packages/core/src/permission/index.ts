export type Permission = "allow" | "ask" | "deny";

export interface PermissionRule {
  tool: string;
  default: Permission;
  allowlist?: string[];
  denylist?: string[];
}

export class PermissionManager {
  private rules = new Map<string, PermissionRule>();
  constructor(rules: PermissionRulep[] = []) {
    for (const r of rules) this.rules.set(r.tool, r);
  }

  check(
    tool: string,
    input: any,
  ): {
    permission: Permission;
    reason: string;
  } {
    const rule = this.rules.get(tool);
    if (!rule) return { permission: "ask", reason: "no rule" };

    const s = typeof input === "string" ? input : JSON.stringify(input);
    if (rule.denylist?.some((p) => this.match(s, p)))
      return { permission: "deny", reason: "denylist" };

    if (rule.allowlist?.some((p) => this.match(s, p)))
      return { permission: "allow", reason: "allowlist" };

    return { permission: rule.default, reason: "default" };
  }

  private match(input: string, pattern: string): boolean {
    if (pattern.includes("*")) {
      return new RegExp(
        "^" +
          pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") +
          "$",
      ).test(input);
    }
    return input.includes(pattern);
  }
}

export const defaultRules: PermissionRule[] = [
  { tool: "read", default: "allow" },
  { tool: "write", default: "allow", denylist: ["/etc/*", "*.pem", "*.key"] },
  { tool: "edit", default: "allow" },
  {
    tool: "bash",
    default: "ask",
    allowlist: [
      "ls *",
      "cat *",
      "head *",
      "tail *",
      "wc *",
      "find *",
      "grep *",
      "git *",
      "echo *",
      "pwd",
      "date",
      "node *",
      "bun *",
      "npm *",
    ],
    denylist: ["rm -rf /*", "sudo *", "chmod -R 777 /*"],
  },
  { tool: "glob", default: "allow" },
  { tool: "grep", default: "allow" },
  { tool: "webfetch", default: "allow" },
  { tool: "memory_get", default: "allow" },
];
