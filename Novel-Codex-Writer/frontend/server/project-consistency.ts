import { existsSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import type { ProjectConsistencyIssue, ProjectConsistencyReport } from "../shared/api-contract.ts";
import { collectFilesInside, readFileInsideLimited } from "./file-storage.ts";
import { getMemoryOverview } from "./memory-overview.ts";

const REQUIRED_DIRECTORIES = ["大纲", "写作规范", "正文", "章节提交", "审查报告", "记忆库/current", "记忆库/index", "记忆库/snapshots", "档案库"];

export async function checkProjectConsistency(projectRoot: string, projectId: string): Promise<ProjectConsistencyReport> {
  const issues: ProjectConsistencyIssue[] = [];
  for (const path of REQUIRED_DIRECTORIES) {
    if (!existsSync(resolve(projectRoot, path))) issues.push({ code: "REQUIRED_DIRECTORY_MISSING", severity: "warning", message: `缺少标准目录：${path}`, path });
  }

  const metadataPath = resolve(projectRoot, "project.json");
  try {
    const parsed = JSON.parse((await readFileInsideLimited(projectRoot, metadataPath, 64 * 1024)).toString("utf8")) as Record<string, unknown>;
    if (parsed.id !== projectId || typeof parsed.name !== "string" || !parsed.name.trim()) throw new Error("metadata mismatch");
  } catch {
    issues.push({ code: "PROJECT_METADATA_INVALID", severity: "error", message: "project.json 缺失、损坏或与当前项目 ID 不一致。", path: "project.json" });
  }

  let files: string[] = [];
  try {
    files = await collectFilesInside(projectRoot, projectRoot, { maxFiles: 5_000, maxBytes: 64 * 1024 * 1024 });
  } catch {
    issues.push({ code: "PROJECT_SCAN_FAILED", severity: "error", message: "项目扫描超过安全预算或包含越界链接；未尝试自动修复。" });
  }

  const chapters = new Map<number, string[]>();
  for (const file of files) {
    const path = relative(projectRoot, file).split(sep).join("/");
    if (!path.startsWith("正文/")) continue;
    const match = path.match(/第\s*0*(\d+)\s*章/i);
    if (!match) continue;
    const chapter = Number(match[1]);
    chapters.set(chapter, [...(chapters.get(chapter) ?? []), path]);
  }
  for (const [chapter, paths] of chapters) {
    if (paths.length > 1) issues.push({ code: "CHAPTER_DUPLICATE", severity: "error", message: `第 ${chapter} 章存在 ${paths.length} 份正式正文，无法唯一判断事实源。`, path: paths.join("；") });
  }

  const memory = await getMemoryOverview(projectRoot, projectId);
  for (const diagnostic of memory.diagnostics) {
    issues.push({
      code: "MEMORY_INDEX_DIAGNOSTIC",
      severity: diagnostic.severity,
      message: diagnostic.message,
      path: "记忆库/index/memory_index.json"
    });
  }
  const status = issues.some((item) => item.severity === "error") ? "error" : issues.length ? "warning" : "ready";
  return { schemaVersion: 1, projectId, status, checkedFiles: files.length, issues };
}
