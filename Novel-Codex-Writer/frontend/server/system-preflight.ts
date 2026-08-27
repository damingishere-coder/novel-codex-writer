import { constants, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { access, lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { SystemPreflight, SystemPreflightCheck } from "../shared/api-contract.ts";
import { assertInsidePath, assertNoSymlinkEscape } from "./file-storage.ts";
import type { ProjectSummary } from "./project-service.ts";

interface PreflightProjectIndex {
  activeProjectId: string | null;
  projects: ProjectSummary[];
}

interface SystemPreflightOptions {
  libraryRoot: string;
  port?: number | null;
  loadProjectIndex(): Promise<PreflightProjectIndex>;
  getProjectRoot(project: ProjectSummary): string;
}

function commandVersion(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 5_000 });
  if (result.status !== 0) return undefined;
  return `${result.stdout || result.stderr}`.trim().split(/\r?\n/)[0] || undefined;
}

function detectPythonVersion() {
  if (process.platform === "win32") {
    return commandVersion("py", ["-3", "--version"]) ?? commandVersion("python", ["--version"]);
  }
  return commandVersion("python3", ["--version"]) ?? commandVersion("python", ["--version"]);
}

function detectNpmVersion() {
  const npmExecPath = process.env.npm_execpath?.trim();
  if (npmExecPath && existsSync(npmExecPath)) return commandVersion(process.execPath, [npmExecPath, "--version"]);
  if (process.platform === "win32") {
    return commandVersion(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm.cmd --version"]);
  }
  return commandVersion("npm", ["--version"]);
}

function check(
  id: SystemPreflightCheck["id"],
  label: string,
  state: SystemPreflightCheck["state"],
  blocking: boolean,
  message: string
): SystemPreflightCheck {
  return { id, label, state, blocking, message };
}

async function pendingTransactionCount(options: SystemPreflightOptions, index: PreflightProjectIndex) {
  let count = 0;
  for (const project of index.projects) {
    const projectRoot = options.getProjectRoot(project);
    const transactionRoot = resolve(projectRoot, "记忆库", ".transactions");
    assertInsidePath(projectRoot, transactionRoot, "事务目录越出当前小说。");
    if (!await pathEntryExists(transactionRoot)) continue;
    assertNoSymlinkEscape(projectRoot, transactionRoot);
    const transactionStat = await lstat(transactionRoot);
    if (!transactionStat.isDirectory()) throw new Error("事务路径不是目录");
    const entries = await readdir(transactionRoot, { withFileTypes: true });
    count += entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).length;
  }
  return count;
}

async function pathEntryExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function getSystemPreflight(options: SystemPreflightOptions): Promise<SystemPreflight> {
  const port = options.port && Number.isInteger(options.port) ? options.port : null;
  const npmVersion = detectNpmVersion();
  const pythonVersion = detectPythonVersion();
  const checks: SystemPreflightCheck[] = [
    check("node", "Node.js", "pass", true, `已连接 ${process.version}`),
    npmVersion
      ? check("npm", "npm", "pass", true, `已连接 npm ${npmVersion}`)
      : check("npm", "npm", "fail", true, "未找到 npm，无法维护本机工作台依赖。"),
    pythonVersion
      ? check("python", "Python", "pass", false, `已连接 ${pythonVersion}`)
      : check("python", "Python", "warning", false, "未找到 Python；阅读编辑可用，任务书和记忆工作流不可用。"),
    check("listener", "本机监听", "pass", true, port ? `工作台正在 127.0.0.1:${port} 运行。` : "工作台已通过本机回环连接。")
  ];

  try {
    await access(options.libraryRoot, constants.R_OK | constants.W_OK);
    checks.push(check("library", "作品库", "pass", true, "唯一作品库可读写。"));
  } catch {
    checks.push(check("library", "作品库", "fail", true, "作品库不可读写，请检查本机目录权限。"));
  }

  let index: PreflightProjectIndex | undefined;
  try {
    index = await options.loadProjectIndex();
    checks.push(check("registry", "作品注册表", "pass", true, `注册表有效，共 ${index.projects.length} 本作品。`));
  } catch {
    checks.push(check("registry", "作品注册表", "fail", true, "作品注册表损坏或无法读取，系统已拒绝覆盖。"));
  }

  if (index) {
    if (!index.projects.length) {
      checks.push(check("activeProject", "当前作品", "warning", false, "尚未创建作品，可以在工作台中新建一本小说。"));
    } else if (index.activeProjectId && index.projects.some((project) => project.id === index!.activeProjectId)) {
      checks.push(check("activeProject", "当前作品", "pass", false, "当前作品指向有效。"));
    } else {
      checks.push(check("activeProject", "当前作品", "warning", false, "未选择有效作品，请在作品管理中重新选择。"));
    }
    try {
      const pending = await pendingTransactionCount(options, index);
      checks.push(pending
        ? check("transactions", "记忆事务", "warning", false, `发现 ${pending} 个未完成事务；默认只报告，不会自动恢复。`)
        : check("transactions", "记忆事务", "pass", false, "没有未完成的记忆事务。"));
    } catch {
      checks.push(check("transactions", "记忆事务", "warning", false, "无法安全检查记忆事务，请运行只读诊断。"));
    }
  } else {
    checks.push(check("activeProject", "当前作品", "warning", false, "作品注册表不可用，无法确认当前作品。"));
    checks.push(check("transactions", "记忆事务", "warning", false, "作品注册表不可用，未检查记忆事务。"));
  }

  return {
    schemaVersion: 1,
    ready: !checks.some((item) => item.blocking && item.state === "fail"),
    runtime: {
      mode: port === 5174 ? "native" : port === 5173 ? "docker" : "custom",
      host: "127.0.0.1",
      port,
      nodeVersion: process.version,
      ...(npmVersion ? { npmVersion } : {}),
      ...(pythonVersion ? { pythonVersion } : {})
    },
    checks
  };
}
