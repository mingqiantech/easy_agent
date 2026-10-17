import fs from "node:fs/promises";

/**
 * 版本号管理（Week 12）
 * 用法: bun run scripts/version.ts patch|minor|major|show
 */
const type = (process.argv[2] ?? "show") as "patch" | "minor" | "major" | "show";

const pkgPath = new URL("../package.json", import.meta.url).pathname;
const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8"));
const current: string = pkg.version ?? "0.0.0";

if (type === "show") {
  console.log(current);
  process.exit(0);
}

if (!["patch", "minor", "major"].includes(type)) {
  console.error(`Usage: version.ts [patch|minor|major|show]`);
  process.exit(1);
}

const [major, minor, patch] = current.split(".").map((n) => parseInt(n, 10) || 0);
const next =
  type === "major"
    ? `${major + 1}.0.0`
    : type === "minor"
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`;

pkg.version = next;
await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
console.log(`✓ ${current} → ${next}`);
