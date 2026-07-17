import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const searchRoots = ["src", "tests", "scripts"];

async function collectTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectTests(path));
    else if (entry.isFile() && /\.test\.(?:ts|mjs)$/.test(entry.name)) files.push(relative(root, path));
  }

  return files;
}

const testFiles = (await Promise.all(searchRoots.map((path) => collectTests(join(root, path))))).flat().sort();

if (testFiles.length === 0) {
  console.error("No test files found under src/, tests/, or scripts/.");
  process.exit(1);
}

const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const child = spawn(command, ["exec", "tsx", "--test", "--test-concurrency=1", ...testFiles], {
  cwd: root,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) return process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
