import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { ApiError, assertInsidePath, atomicWriteJson, revisionOf } from "./file-storage";
import type { WorkflowArtifact, WorkflowContextItem, WorkflowState } from "../shared/api-contract";

interface WorkflowOptions {
  projectRoot: string;
  projectId: string;
  chapter?: number;
}

function projectPath(projectRoot: string, target: string) {
  return relative(projectRoot, target).split(sep).join("/");
}

function extractChapter(value: string) {
  const match = value.match(/第\s*0*(\d+)\s*章/);
  return match ? Number(match[1]) : undefined;
}

async function markdownFiles(root: string) {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".md")
    .map((entry) => resolve(root, entry.name));
}

async function fileInfo(projectRoot: string, path?: string) {
  if (!path || !existsSync(path)) return undefined;
  const content = await readFile(path, "utf8");
  return { path: projectPath(projectRoot, path), revision: revisionOf(content), content };
}

async function findChapterFile(root: string, chapter: number, filter?: (path: string) => boolean) {
  const matches = (await markdownFiles(root)).filter((path) => extractChapter(basename(path)) === chapter && (!filter || filter(path)));
  if (matches.length > 1) throw new ApiError(409, `第${String(chapter).padStart(3, "0")}章存在多个候选文件：${matches.map((path) => basename(path)).join("、")}`);
  return matches[0];
}

async function inferChapter(projectRoot: string) {
  const bodies = await markdownFiles(resolve(projectRoot, "正文"));
  const bodyNumbers = bodies.map((path) => extractChapter(basename(path))).filter((value): value is number => Boolean(value));
  if (bodyNumbers.length) return Math.max(...bodyNumbers);
  const outlines = await markdownFiles(resolve(projectRoot, "大纲"));
  const outlineNumbers = outlines.map((path) => extractChapter(basename(path))).filter((value): value is number => Boolean(value));
  return outlineNumbers.length ? Math.min(...outlineNumbers) : 1;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function taskbookStatus(projectRoot: string, chapter: number): Promise<WorkflowArtifact> {
  const path = resolve(projectRoot, "记忆库", "current", "本章写作任务书.md");
  const info = await fileInfo(projectRoot, path);
  if (!info) return { id: "taskbook", label: "任务书", status: "missing", message: "尚未生成本章写作任务书。" };
  const metadata = await readJson(`${path}.meta.json`);
  if (!metadata || metadata.chapter !== chapter || metadata.taskbook_revision !== info.revision) {
    return { id: "taskbook", label: "任务书", status: "stale", path: info.path, revision: info.revision, message: "任务书没有绑定当前章节或正文来源。" };
  }
  const sources = Array.isArray(metadata.sources) ? metadata.sources : [];
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const item = source as Record<string, unknown>;
    if (typeof item.path !== "string" || typeof item.revision !== "string") continue;
    const target = resolve(projectRoot, item.path);
    assertInsidePath(projectRoot, target, "任务书来源越界。");
    if (!existsSync(target) || revisionOf(await readFile(target)) !== item.revision) {
      return { id: "taskbook", label: "任务书", status: "stale", path: info.path, revision: info.revision, message: `来源已变化：${item.path}` };
    }
  }
  const status = metadata.status === "blocked" ? "blocked" : "ready";
  return { id: "taskbook", label: "任务书", status, path: info.path, revision: info.revision, message: status === "ready" ? "任务书与来源 revision 一致。" : "任务书记录了工作流阻断。" };
}

function parsePatch(content: string) {
  const fenced = content.match(/```json\s*([\s\S]*?)\s*```/i);
  try {
    const parsed = JSON.parse(fenced?.[1] ?? content);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function patchStatus(projectRoot: string, chapter: number, bodyRevision?: string): Promise<WorkflowArtifact & { legacyChoices?: string[] }> {
  const patchRoot = resolve(projectRoot, "章节提交");
  const files = (await markdownFiles(patchRoot)).filter((path) => basename(path).startsWith("memory_patch_"));
  const classificationsFile = existsSync(resolve(patchRoot, "compat", "patch_classifications.json"))
    ? resolve(patchRoot, "compat", "patch_classifications.json")
    : resolve(patchRoot, "patch_classifications.json");
  const classifications = (await readJson(classificationsFile))?.classifications;
  const classificationMap = classifications && typeof classifications === "object" ? classifications as Record<string, unknown> : {};
  const patches = (await Promise.all(files.map(async (path) => {
    const content = await readFile(path, "utf8");
    const patch = parsePatch(content);
    if (!patch || patch.chapter !== chapter || typeof patch.patch_id !== "string") return null;
    const kind = patch.schema_version === 2 ? patch.kind : classificationMap[patch.patch_id] ?? "legacy_unknown";
    return { path, content, patch, kind };
  }))).filter((value): value is NonNullable<typeof value> => Boolean(value));
  const results = patches.filter((item) => item.kind === "chapter_result");
  const legacy = patches.filter((item) => item.kind === "legacy_unknown");
  const manifestPath = resolve(patchRoot, `第${String(chapter).padStart(3, "0")}章_finalization.json`);
  const manifest = await readJson(manifestPath);
  const currentRevisionResults = bodyRevision
    ? results.filter((item) => item.patch.chapter_revision === bodyRevision)
    : [];
  const selectedByManifest = typeof manifest?.patch_id === "string"
    ? results.find((item) => item.patch.patch_id === manifest.patch_id)
    : undefined;
  if (results.length > 1 && currentRevisionResults.length !== 1 && !selectedByManifest) {
    return {
      id: "memoryPatch",
      label: "记忆更新",
      status: "blocked",
      message: "同章存在多个 schema v2 chapter_result；请通过最终化 manifest 明确当前结果后再继续。"
    };
  }
  if (!results.length && legacy.length > 1) {
    return {
      id: "memoryPatch",
      label: "记忆更新",
      status: "blocked",
      message: "同章存在多个旧 patch，必须先由作者确认正文结果。",
      legacyChoices: legacy.map((item) => String(item.patch.patch_id))
    };
  }
  const selected = currentRevisionResults.length === 1
    ? currentRevisionResults[0]
    : selectedByManifest ?? results[0] ?? (legacy.length === 1 ? legacy[0] : undefined);
  if (!selected) return { id: "memoryPatch", label: "记忆更新", status: "missing", message: "尚未生成或确认 chapter_result patch。" };
  const info = await fileInfo(projectRoot, selected.path);
  if (selected.patch.schema_version === 2 && bodyRevision && selected.patch.chapter_revision !== bodyRevision) {
    return { id: "memoryPatch", label: "记忆更新", status: "stale", path: info?.path, revision: info?.revision, message: "patch 绑定的正文 revision 已过期。" };
  }
  if (!manifest) return { id: "memoryPatch", label: "记忆更新", status: "ready", path: info?.path, revision: info?.revision, message: "patch 已就绪，等待作者确认应用。" };
  if (manifest.patch_id !== selected.patch.patch_id) {
    return { id: "memoryPatch", label: "记忆更新", status: "ready", path: info?.path, revision: info?.revision, message: "发现绑定当前正文的新 patch，等待作者确认替换旧最终化 manifest。" };
  }
  const evidence = [
    ...(Array.isArray(manifest.sources) ? manifest.sources : []),
    manifest.patch
  ];
  for (const source of evidence) {
    if (!source || typeof source !== "object") return { id: "memoryPatch", label: "记忆更新", status: "stale", path: info?.path, revision: info?.revision, message: "最终化 manifest 格式不完整。" };
    const item = source as Record<string, unknown>;
    if (typeof item.path !== "string" || typeof item.revision !== "string") continue;
    const target = resolve(projectRoot, item.path);
    assertInsidePath(projectRoot, target, "最终化来源越界。");
    if (!existsSync(target) || revisionOf(await readFile(target)) !== item.revision) {
      return { id: "memoryPatch", label: "记忆更新", status: "stale", path: info?.path, revision: info?.revision, message: `最终化来源已变化：${item.path}` };
    }
  }
  return { id: "memoryPatch", label: "记忆更新", status: "finalized", path: info?.path, revision: info?.revision, message: "章节 manifest 与所有来源 revision 一致。" };
}

async function reviewContext(projectRoot: string, chapter: number, bodyPath?: string): Promise<WorkflowContextItem[]> {
  const values: WorkflowContextItem[] = [];
  const add = async (path: string, role: string, expected?: string) => {
    const target = resolve(projectRoot, path);
    assertInsidePath(projectRoot, target, "审阅上下文越界。");
    if (!existsSync(target)) {
      values.push({ path, role, missing: true, stale: false });
      return;
    }
    const revision = revisionOf(await readFile(target));
    values.push({ path, role, revision, missing: false, stale: Boolean(expected && expected !== revision) });
  };
  if (bodyPath) await add(projectPath(projectRoot, bodyPath), "当前草稿");
  await add("记忆库/current/本章写作任务书.md", "本章任务书");
  for (let number = Math.max(1, chapter - 5); number < chapter; number += 1) {
    const previous = await findChapterFile(resolve(projectRoot, "正文"), number);
    if (previous) await add(projectPath(projectRoot, previous), `前置正文 第${String(number).padStart(3, "0")}章`);
    else values.push({ path: `正文/第${String(number).padStart(3, "0")}章`, role: "缺失前置正文", missing: true, stale: false });
  }
  const metadata = await readJson(resolve(projectRoot, "记忆库", "current", "本章写作任务书.md.meta.json"));
  if (Array.isArray(metadata?.sources)) {
    for (const source of metadata.sources) {
      if (!source || typeof source !== "object") continue;
      const item = source as Record<string, unknown>;
      if (typeof item.path === "string") await add(item.path, "任务书来源", typeof item.revision === "string" ? item.revision : undefined);
    }
  }
  return values.filter((item, index, array) => array.findIndex((candidate) => candidate.path === item.path) === index);
}

export async function getWorkflowStatus(options: WorkflowOptions) {
  const chapter = options.chapter && options.chapter > 0 ? options.chapter : await inferChapter(options.projectRoot);
  const label = String(chapter).padStart(3, "0");
  const blueprintPath = await findChapterFile(resolve(options.projectRoot, "大纲"), chapter, (path) => basename(path).includes("细纲"));
  const blueprintInfo = await fileInfo(options.projectRoot, blueprintPath);
  const blueprint: WorkflowArtifact = blueprintInfo
    ? { id: "blueprint", label: "细纲", status: "ready", path: blueprintInfo.path, revision: blueprintInfo.revision, message: "本章细纲已存在。" }
    : { id: "blueprint", label: "细纲", status: "missing", message: "缺少本章细纲。" };
  const taskbook = await taskbookStatus(options.projectRoot, chapter);
  const bodyPath = await findChapterFile(resolve(options.projectRoot, "正文"), chapter);
  const bodyInfo = await fileInfo(options.projectRoot, bodyPath);
  const body: WorkflowArtifact = bodyInfo
    ? { id: "body", label: "正文", status: "ready", path: bodyInfo.path, revision: bodyInfo.revision, message: "正文已保存。" }
    : { id: "body", label: "正文", status: "missing", message: "尚未保存本章正文。" };
  const reviewPath = await findChapterFile(resolve(options.projectRoot, "审查报告"), chapter);
  const reviewInfo = await fileInfo(options.projectRoot, reviewPath);
  const reviewPass = Boolean(reviewInfo && bodyInfo && reviewInfo.content.includes(bodyInfo.revision) && /(?:结果|结论)：通过/.test(reviewInfo.content));
  const review: WorkflowArtifact = !reviewInfo
    ? { id: "review", label: "审查", status: "missing", message: "尚未生成审查报告。" }
    : !bodyInfo || !reviewInfo.content.includes(bodyInfo.revision)
      ? { id: "review", label: "审查", status: "stale", path: reviewInfo.path, revision: reviewInfo.revision, message: "审查报告未绑定当前正文 revision。" }
      : reviewPass
        ? { id: "review", label: "审查", status: "ready", path: reviewInfo.path, revision: reviewInfo.revision, message: "审查通过且 revision 一致。" }
        : { id: "review", label: "审查", status: "needs_changes", path: reviewInfo.path, revision: reviewInfo.revision, message: "审查要求修改正文。" };
  const commitPath = await findChapterFile(resolve(options.projectRoot, "章节提交"), chapter, (path) => !basename(path).startsWith("memory_patch_"));
  const commitInfo = await fileInfo(options.projectRoot, commitPath);
  const commit: WorkflowArtifact = !commitInfo
    ? { id: "commit", label: "章节提交", status: "missing", message: "尚未记录章节提交。" }
    : !bodyInfo || !commitInfo.content.includes(bodyInfo.revision)
      ? { id: "commit", label: "章节提交", status: "stale", path: commitInfo.path, revision: commitInfo.revision, message: "提交记录未绑定当前正文 revision。" }
      : { id: "commit", label: "章节提交", status: "ready", path: commitInfo.path, revision: commitInfo.revision, message: "提交记录与正文 revision 一致。" };
  const memoryPatch = await patchStatus(options.projectRoot, chapter, bodyInfo?.revision);
  const artifacts = [blueprint, taskbook, body, review, commit, memoryPatch];
  let state: WorkflowState = "ready";
  let recommendedAction = "copy_to_codex";
  let recommendation = "复制本章资料给 Codex，继续需要创作判断的步骤。";
  if (artifacts.some((item) => item.status === "blocked")) {
    state = "blocked";
    recommendedAction = "classify_patch";
    recommendation = "先确认同章旧 patch 的语义，未确认前不能写下一章。";
  } else if (blueprint.status === "missing") {
    state = "blocked";
    recommendedAction = "copy_to_codex";
    recommendation = `请先创建并确认第${label}章细纲。`;
  } else if (taskbook.status !== "ready") {
    state = taskbook.status === "blocked" ? "blocked" : "needs_changes";
    recommendedAction = "generate_taskbook";
    recommendation = "重新诊断并生成绑定当前来源的任务书。";
  } else if (body.status === "missing") {
    recommendedAction = "copy_to_codex";
    recommendation = "任务书已就绪，请复制给 Codex 创作正文。";
  } else if (review.status === "missing" || review.status === "stale") {
    state = "needs_changes";
    recommendedAction = "check_body";
    recommendation = "检查当前正文，生成绑定 revision 的审查报告。";
  } else if (review.status === "needs_changes") {
    state = "needs_changes";
    recommendedAction = "copy_to_codex";
    recommendation = "按审查 Findings 修改正文，再重新检查。";
  } else if (commit.status !== "ready") {
    state = "needs_changes";
    recommendedAction = "copy_to_codex";
    recommendation = "请生成绑定当前正文 revision 的章节提交记录。";
  } else if (memoryPatch.status === "missing" || memoryPatch.status === "stale") {
    state = "needs_changes";
    recommendedAction = "copy_to_codex";
    recommendation = "请生成 schema v2 chapter_result patch，并先做最终化预检。";
  } else if (memoryPatch.status === "ready") {
    recommendedAction = "apply_patch";
    recommendation = "所有证据已就绪；作者确认后应用 patch 完成最终化。";
  } else if (memoryPatch.status === "finalized") {
    state = "finalized";
    recommendedAction = "copy_to_codex";
    recommendation = "本章已最终化，可以准备下一章。";
  }
  return {
    schemaVersion: 1,
    projectId: options.projectId,
    chapter,
    state,
    artifacts,
    recommendedAction,
    recommendation,
    reviewContext: await reviewContext(options.projectRoot, chapter, bodyPath),
    legacyPatchChoices: memoryPatch.legacyChoices ?? []
  };
}

async function runPython(args: string[], cwd: string) {
  return new Promise<{ exitCode: number; output: string }>((resolvePromise, reject) => {
    const child = spawn("python", ["-X", "utf8", ...args], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ exitCode: code ?? 2, output: output.slice(-20_000) }));
  });
}

export async function runWorkflowAction(input: {
  action: string;
  projectRoot: string;
  projectId: string;
  libraryRoot: string;
  workspaceRoot: string;
  chapter: number;
  patchPath?: string;
  confirmed?: boolean;
  classifications?: Record<string, string>;
}) {
  const scripts = resolve(input.workspaceRoot, ".agents", "skills", "webnovel-writer", "scripts");
  const common = ["--library-root", input.libraryRoot, "--project-root", input.projectRoot];
  if (input.action === "diagnose" || input.action === "finalization_preflight") {
    return { action: input.action, status: await getWorkflowStatus(input) };
  }
  if (input.action === "generate_taskbook") {
    const result = await runPython([resolve(scripts, "build_context.py"), "--chapter", String(input.chapter), ...common], input.workspaceRoot);
    if (result.exitCode !== 0) throw new ApiError(409, result.output.trim() || "任务书生成被阻断。");
    return { action: input.action, output: result.output, status: await getWorkflowStatus(input) };
  }
  if (input.action === "check_body") {
    const body = await findChapterFile(resolve(input.projectRoot, "正文"), input.chapter);
    if (!body) throw new ApiError(409, "尚未保存本章正文。");
    const output = resolve(input.projectRoot, "审查报告", `第${String(input.chapter).padStart(3, "0")}章_审查报告.md`);
    const result = await runPython([
      resolve(scripts, "check_chapter.py"), body, "--chapter", String(input.chapter), "--output", output, ...common
    ], input.workspaceRoot);
    if (result.exitCode > 1) throw new ApiError(409, result.output.trim() || "正文检查失败。");
    return { action: input.action, output: result.output, status: await getWorkflowStatus(input) };
  }
  if (input.action === "apply_patch") {
    if (!input.confirmed) throw new ApiError(400, "应用 memory patch 前必须由作者明确确认。")
    if (!input.patchPath) throw new ApiError(400, "缺少 patchPath。")
    const patchPath = resolve(input.projectRoot, input.patchPath);
    assertInsidePath(input.projectRoot, patchPath, "patch 路径越界。");
    const result = await runPython([
      resolve(scripts, "update_memory.py"), "--patch", patchPath, "--library-root", input.libraryRoot
    ], input.workspaceRoot);
    if (result.exitCode !== 0) throw new ApiError(409, result.output.trim() || "memory patch 应用失败。");
    return { action: input.action, output: result.output, status: await getWorkflowStatus(input) };
  }
  if (input.action === "classify_patch") {
    if (!input.confirmed) throw new ApiError(400, "旧 patch 分类必须由作者明确确认。")
    const allowed = new Set(["chapter_result", "outline_baseline", "migration"]);
    const classifications = input.classifications ?? {};
    if (!Object.keys(classifications).length || Object.values(classifications).some((value) => !allowed.has(value))) {
      throw new ApiError(400, "patch 分类不完整或包含不支持的 kind。")
    }
    if (Object.values(classifications).filter((value) => value === "chapter_result").length !== 1) {
      throw new ApiError(400, "同一章必须且只能确认一个 chapter_result。")
    }
    const legacyTarget = resolve(input.projectRoot, "章节提交", "patch_classifications.json");
    const currentTarget = resolve(input.projectRoot, "章节提交", "compat", "patch_classifications.json");
    const existingFile = existsSync(currentTarget) ? currentTarget : legacyTarget;
    const existingPayload = await readJson(existingFile);
    const existingClassifications = existingPayload?.classifications && typeof existingPayload.classifications === "object" && !Array.isArray(existingPayload.classifications)
      ? existingPayload.classifications as Record<string, string>
      : {};
    const target = resolve(input.projectRoot, "章节提交", "compat", "patch_classifications.json");
    await atomicWriteJson(target, {
      schema_version: 1,
      updated_at: new Date().toISOString(),
      classifications: { ...existingClassifications, ...classifications }
    });
    return { action: input.action, status: await getWorkflowStatus(input) };
  }
  throw new ApiError(400, "不支持的工作流动作。")
}
