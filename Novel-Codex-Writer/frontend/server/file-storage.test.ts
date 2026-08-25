import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApiError,
  assertNoSymlinkEscape,
  collectFilesInside,
  exportBookMarkdown,
  exportProjectZip,
  projectBackupExcluded,
  readFileInsideLimited,
  listDocumentVersions,
  listTrashEntries,
  previewVersionDiff,
  restoreDocumentVersion,
  restoreTrashEntry,
  revisionOf,
  saveHistoryVersion,
  writeDocumentVersioned
} from "./file-storage";

const temporaryRoots: string[] = [];

async function temporaryRoot() {
  const root = await mkdtemp(resolve(tmpdir(), "novel-storage-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("document history", () => {
  it("lists, diffs and restores with optimistic revision checks", async () => {
    const projectRoot = resolve(await temporaryRoot(), "project");
    const target = resolve(projectRoot, "正文", "第001章.md");
    await mkdir(resolve(projectRoot, "正文"), { recursive: true });
    const first = "# 第001章\n\n版本一\n";
    const second = "# 第001章\n\n版本二\n";
    await writeFile(target, first, "utf8");
    await saveHistoryVersion(projectRoot, "正文/第001章.md", first);
    await writeFile(target, second, "utf8");

    const versions = await listDocumentVersions(projectRoot, "正文/第001章.md");
    expect(versions).toHaveLength(1);
    const diff = await previewVersionDiff(projectRoot, "正文/第001章.md", versions[0].id, second);
    expect(diff.before).toContain("版本一");
    expect(diff.after).toContain("版本二");

    await expect(restoreDocumentVersion(
      projectRoot,
      "正文/第001章.md",
      versions[0].id,
      target,
      revisionOf("冲突")
    )).rejects.toMatchObject({ statusCode: 409 });
    await restoreDocumentVersion(projectRoot, "正文/第001章.md", versions[0].id, target, revisionOf(second));
    expect(await readFile(target, "utf8")).toBe(first);
    expect(await listDocumentVersions(projectRoot, "正文/第001章.md")).toHaveLength(2);
  });

  it("serializes concurrent saves that share one expected revision", async () => {
    const projectRoot = resolve(await temporaryRoot(), "project");
    const target = resolve(projectRoot, "正文", "第001章.md");
    await mkdir(resolve(target, ".."), { recursive: true });
    const initial = "# 第001章\n\n初稿\n";
    await writeFile(target, initial, "utf8");

    const outcomes = await Promise.allSettled([
      writeDocumentVersioned(projectRoot, "正文/第001章.md", target, "# 第001章\n\n版本 A\n", revisionOf(initial)),
      writeDocumentVersioned(projectRoot, "正文/第001章.md", target, "# 第001章\n\n版本 B\n", revisionOf(initial))
    ]);

    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((item): item is PromiseRejectedResult => item.status === "rejected");
    expect(rejected?.reason).toMatchObject({ statusCode: 409 });
    expect(["# 第001章\n\n版本 A\n", "# 第001章\n\n版本 B\n"]).toContain(await readFile(target, "utf8"));
    const versions = await listDocumentVersions(projectRoot, "正文/第001章.md");
    expect(versions.map((item) => item.revision)).toEqual([revisionOf(initial)]);
  });

  it("rejects a history file whose content no longer matches its revision", async () => {
    const projectRoot = resolve(await temporaryRoot(), "project");
    const target = resolve(projectRoot, "正文", "第001章.md");
    await mkdir(resolve(target, ".."), { recursive: true });
    const initial = "# 第001章\n\n初稿\n";
    await writeFile(target, initial, "utf8");
    await saveHistoryVersion(projectRoot, "正文/第001章.md", initial);
    const [historyDirectory] = await readdir(resolve(projectRoot, ".history"));
    const historyFiles = await readdir(resolve(projectRoot, ".history", historyDirectory));
    const versionFile = historyFiles.find((name) => name.endsWith(".md"));
    expect(versionFile).toBeDefined();
    await writeFile(resolve(projectRoot, ".history", historyDirectory, versionFile!), "被篡改的历史", "utf8");

    await expect(listDocumentVersions(projectRoot, "正文/第001章.md")).rejects.toMatchObject({
      statusCode: 409,
      code: "HISTORY_VERSION_CORRUPT"
    });
  });

  it("bounds history reads to the newest 30 versions without destructively deleting older snapshots", async () => {
    const projectRoot = resolve(await temporaryRoot(), "project");
    const target = resolve(projectRoot, "正文", "第001章.md");
    await mkdir(resolve(target, ".."), { recursive: true });
    const initial = "# 第001章\n\n初稿\n";
    await writeFile(target, initial, "utf8");
    await saveHistoryVersion(projectRoot, "正文/第001章.md", initial);
    const [historyDirectory] = await readdir(resolve(projectRoot, ".history"));
    const historyRoot = resolve(projectRoot, ".history", historyDirectory);
    for (let index = 1; index < 35; index += 1) {
      const content = `历史版本 ${index}`;
      await writeFile(
        resolve(historyRoot, `2026-08-26T00-00-${String(index).padStart(2, "0")}-${revisionOf(content)}.md`),
        content,
        "utf8"
      );
    }
    const duplicateContent = "历史版本 34";
    await writeFile(resolve(historyRoot, `zzz-duplicate-${revisionOf(duplicateContent)}.md`), duplicateContent, "utf8");

    const visible = await listDocumentVersions(projectRoot, "正文/第001章.md");
    expect(visible).toHaveLength(30);
    expect(new Set(visible.map((item) => item.revision)).size).toBe(30);
    await saveHistoryVersion(projectRoot, "正文/第001章.md", initial);
    expect((await readdir(historyRoot)).filter((name) => name.endsWith(".md"))).toHaveLength(36);
  });

  it("rejects an already pathological history directory before reading every file", async () => {
    const projectRoot = resolve(await temporaryRoot(), "project");
    const target = resolve(projectRoot, "正文", "第001章.md");
    await mkdir(resolve(target, ".."), { recursive: true });
    const initial = "初稿";
    await writeFile(target, initial, "utf8");
    await saveHistoryVersion(projectRoot, "正文/第001章.md", initial);
    const [historyDirectory] = await readdir(resolve(projectRoot, ".history"));
    const historyRoot = resolve(projectRoot, ".history", historyDirectory);
    for (let index = 0; index < 512; index += 1) {
      await writeFile(resolve(historyRoot, `extra-${String(index).padStart(5, "0")}.txt`), "", "utf8");
    }

    await expect(saveHistoryVersion(projectRoot, "正文/第001章.md", "新版本")).rejects.toMatchObject({
      statusCode: 413,
      code: "HISTORY_ENTRY_LIMIT"
    });
    await writeFile(resolve(historyRoot, "one-more-entry.txt"), "", "utf8");

    await expect(listDocumentVersions(projectRoot, "正文/第001章.md")).rejects.toMatchObject({
      statusCode: 413,
      code: "HISTORY_ENTRY_LIMIT"
    });
  });

  it("refuses to persist a history version that its own read path cannot restore", async () => {
    const projectRoot = resolve(await temporaryRoot(), "project");
    await mkdir(projectRoot, { recursive: true });
    await expect(saveHistoryVersion(projectRoot, "正文/第001章.md", "大".repeat(2 * 1024 * 1024 + 1)))
      .rejects.toMatchObject({ statusCode: 413, code: "HISTORY_VERSION_TOO_LARGE" });
  });

  it("uses one lock for lexical aliases of the same document", async () => {
    const projectRoot = resolve(await temporaryRoot(), "project");
    const target = resolve(projectRoot, "正文", "第001章.md");
    await mkdir(resolve(target, ".."), { recursive: true });
    const initial = "# 第001章\n\n初稿\n";
    await writeFile(target, initial, "utf8");

    const outcomes = await Promise.allSettled([
      writeDocumentVersioned(projectRoot, "正文/./第001章.md", target, "版本 A", revisionOf(initial)),
      writeDocumentVersioned(projectRoot, "正文//第001章.md", target, "版本 B", revisionOf(initial))
    ]);

    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((item): item is PromiseRejectedResult => item.status === "rejected")?.reason).toMatchObject({ statusCode: 409 });
  });

  it("serializes restore against a concurrent save", async () => {
    const projectRoot = resolve(await temporaryRoot(), "project");
    const target = resolve(projectRoot, "正文", "第001章.md");
    await mkdir(resolve(target, ".."), { recursive: true });
    const first = "# 第001章\n\n版本一\n";
    const second = "# 第001章\n\n版本二\n";
    const third = "# 第001章\n\n版本三\n";
    await writeFile(target, first, "utf8");
    await saveHistoryVersion(projectRoot, "正文/第001章.md", first);
    const [version] = await listDocumentVersions(projectRoot, "正文/第001章.md");
    await writeFile(target, second, "utf8");

    const outcomes = await Promise.allSettled([
      restoreDocumentVersion(projectRoot, "正文/第001章.md", version.id, target, revisionOf(second)),
      writeDocumentVersioned(projectRoot, "正文/第001章.md", target, third, revisionOf(second))
    ]);

    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((item): item is PromiseRejectedResult => item.status === "rejected");
    expect(rejected?.reason).toMatchObject({ statusCode: 409 });
    expect([first, third]).toContain(await readFile(target, "utf8"));
    const versions = await listDocumentVersions(projectRoot, "正文/第001章.md");
    expect(versions.map((item) => item.revision)).toContain(revisionOf(second));
  });
});

describe("trash restore", () => {
  it("supports current trash layout and refuses silent overwrite", async () => {
    const root = await temporaryRoot();
    const libraryRoot = resolve(root, "library");
    const trashRoot = resolve(libraryRoot, ".trash");
    const projectRoot = resolve(libraryRoot, "作品", "novel-test");
    const trashed = resolve(trashRoot, "files", "novel-test", "stamp", "正文", "第001章.md");
    const target = resolve(projectRoot, "正文", "第001章.md");
    await mkdir(resolve(trashed, ".."), { recursive: true });
    await mkdir(resolve(target, ".."), { recursive: true });
    const recoveryRoot = resolve(trashRoot, ".restored", "novel-test");
    await mkdir(recoveryRoot, { recursive: true });
    await Promise.all(Array.from({ length: 30 }, (_, index) =>
      writeFile(resolve(recoveryRoot, `${String(index).padStart(2, "0")}.restored`), "旧安全副本", "utf8")
    ));
    await writeFile(trashed, "旧正文", "utf8");
    const [entry] = await listTrashEntries(libraryRoot, trashRoot, "novel-test");
    expect(entry.path).toBe("正文/第001章.md");
    await writeFile(target, "当前正文", "utf8");
    await expect(restoreTrashEntry(libraryRoot, trashRoot, projectRoot, "novel-test", entry.id)).rejects.toMatchObject({ statusCode: 409 });
    await rm(target);
    await expect(restoreTrashEntry(libraryRoot, trashRoot, projectRoot, "novel-test", entry.id)).resolves.toMatchObject({ restored: true, path: "正文/第001章.md", recoveryArchived: false });
    expect(await readFile(target, "utf8")).toBe("旧正文");
    expect(await listTrashEntries(libraryRoot, trashRoot, "novel-test")).toHaveLength(1);
    const recoveryFiles = (await readdir(recoveryRoot)).filter((name) => name.endsWith(".restored"));
    expect(recoveryFiles).toHaveLength(30);
    expect(await readFile(trashed, "utf8")).toBe("旧正文");
  });
});

describe("exports and path safety", () => {
  it("enforces the byte budget against bytes actually read", async () => {
    const projectRoot = resolve(await temporaryRoot(), "project");
    await mkdir(projectRoot, { recursive: true });
    const target = resolve(projectRoot, "growing.md");
    await writeFile(target, "12345678901", "utf8");
    await expect(readFileInsideLimited(projectRoot, target, 10)).rejects.toMatchObject({
      statusCode: 413,
      code: "READ_BYTE_LIMIT"
    });
  });

  it("orders chapters, reports gaps, and excludes secrets and logs from ZIP", async () => {
    const projectRoot = resolve(await temporaryRoot(), "第999章缓存", "project");
    await mkdir(resolve(projectRoot, "正文"), { recursive: true });
    await mkdir(resolve(projectRoot, ".history", "test"), { recursive: true });
    await mkdir(resolve(projectRoot, ".git", "objects", "aa"), { recursive: true });
    await writeFile(resolve(projectRoot, "正文", "第003章.md"), "# 第003章\n", "utf8");
    await writeFile(resolve(projectRoot, "正文", "第001章.md"), "# 第001章\n", "utf8");
    await writeFile(resolve(projectRoot, ".history", "test", "old.md"), "历史", "utf8");
    await writeFile(resolve(projectRoot, ".env"), "SECRET=never", "utf8");
    await writeFile(resolve(projectRoot, ".env.local"), "LOCAL_SECRET=never", "utf8");
    await writeFile(resolve(projectRoot, "client.pem"), "PRIVATE_KEY=never", "utf8");
    await writeFile(resolve(projectRoot, "credentials.json"), "CREDENTIAL=never", "utf8");
    await writeFile(resolve(projectRoot, "auth.json"), "AUTH=never", "utf8");
    await writeFile(resolve(projectRoot, "token.json"), "TOKEN=never", "utf8");
    await writeFile(resolve(projectRoot, "client_secret.json"), "CLIENT_SECRET=never", "utf8");
    await writeFile(resolve(projectRoot, ".npmrc"), "NPM_TOKEN=never", "utf8");
    await writeFile(resolve(projectRoot, "cookies.json"), "COOKIE=never", "utf8");
    await writeFile(resolve(projectRoot, "server.log"), "private log", "utf8");
    await writeFile(resolve(projectRoot, ".git", "objects", "aa", "private-object"), "deleted private history", "utf8");
    const markdown = await exportBookMarkdown(projectRoot, "测试小说");
    expect(markdown.missingChapters).toEqual([2]);
    const markdownContent = await readFile(resolve(projectRoot, markdown.path), "utf8");
    expect(markdownContent.indexOf("第001章")).toBeLessThan(markdownContent.indexOf("第003章"));

    const zip = await exportProjectZip(projectRoot, {
      id: "novel-test",
      name: "测试小说",
      createdAt: "2026-08-22T00:00:00Z",
      updatedAt: "2026-08-22T00:00:00Z"
    });
    const zipBytes = await readFile(resolve(projectRoot, zip.path));
    expect(zipBytes.includes(Buffer.from("project/正文/第001章.md"))).toBe(true);
    expect(zipBytes.includes(Buffer.from("project/.history/test/old.md"))).toBe(true);
    expect(zipBytes.includes(Buffer.from("library-project.json"))).toBe(true);
    expect(zipBytes.includes(Buffer.from("SECRET=never"))).toBe(false);
    expect(zipBytes.includes(Buffer.from("LOCAL_SECRET=never"))).toBe(false);
    expect(zipBytes.includes(Buffer.from("PRIVATE_KEY=never"))).toBe(false);
    expect(zipBytes.includes(Buffer.from("CREDENTIAL=never"))).toBe(false);
    expect(zipBytes.includes(Buffer.from("AUTH=never"))).toBe(false);
    expect(zipBytes.includes(Buffer.from("TOKEN=never"))).toBe(false);
    expect(zipBytes.includes(Buffer.from("CLIENT_SECRET=never"))).toBe(false);
    expect(zipBytes.includes(Buffer.from("NPM_TOKEN=never"))).toBe(false);
    expect(zipBytes.includes(Buffer.from("COOKIE=never"))).toBe(false);
    expect(zipBytes.includes(Buffer.from("private log"))).toBe(false);
    expect(zipBytes.includes(Buffer.from("deleted private history"))).toBe(false);
  });

  it("fails closed for an empty book export and recognizes credential filenames", async () => {
    const projectRoot = resolve(await temporaryRoot(), "project");
    await mkdir(resolve(projectRoot, "正文"), { recursive: true });
    await expect(exportBookMarkdown(projectRoot, "空小说")).rejects.toMatchObject({
      statusCode: 422,
      code: "BOOK_EXPORT_EMPTY"
    });
    for (const name of [
      ".env.production", "private.key", "client.p12", "credentials.json", "auth.json", "token.json",
      "client_secret.json", ".npmrc", "cookies.json", ".ssh/id_ed25519", ".aws/credentials", ".git/config", ".git/objects/aa/bb"
    ]) {
      expect(projectBackupExcluded(name)).toBe(true);
    }
  });

  it("rejects escaping directory links through real export entrypoints", async () => {
    const root = await temporaryRoot();
    const projectRoot = resolve(root, "project");
    const outside = resolve(root, "outside");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    const link = resolve(projectRoot, "正文");
    try {
      await symlink(outside, link, "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    expect(() => assertNoSymlinkEscape(projectRoot, resolve(link, "第001章.md"))).toThrow(ApiError);
    await expect(exportBookMarkdown(projectRoot, "测试小说")).rejects.toThrow(ApiError);
    await rm(link);
    await writeFile(resolve(outside, "sentinel.md"), "项目外哨兵", "utf8");
    await symlink(outside, resolve(projectRoot, "档案库"), "junction");
    await expect(exportProjectZip(projectRoot, {
      id: "novel-test",
      name: "测试小说",
      createdAt: "2026-08-22T00:00:00Z",
      updatedAt: "2026-08-22T00:00:00Z"
    })).rejects.toThrow(ApiError);
  });

  it("rejects a dangling symlink before treating the target as missing", async () => {
    const root = await temporaryRoot();
    const projectRoot = resolve(root, "project");
    const target = resolve(projectRoot, "正文", "第001章.md");
    await mkdir(resolve(projectRoot, "正文"), { recursive: true });
    try {
      await symlink(resolve(root, "missing-outside.md"), target, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    expect(() => assertNoSymlinkEscape(projectRoot, target)).toThrowError(expect.objectContaining({
      statusCode: 403,
      code: "SYMLINK_TARGET_FORBIDDEN"
    }));
    await expect(collectFilesInside(projectRoot, target)).rejects.toMatchObject({
      statusCode: 403,
      code: "SYMLINK_TARGET_FORBIDDEN"
    });
  });

  it("rejects a trash collection junction that escapes the library root", async () => {
    const root = await temporaryRoot();
    const libraryRoot = resolve(root, "library");
    const outside = resolve(root, "outside-trash");
    const trashRoot = resolve(libraryRoot, ".trash");
    await mkdir(resolve(libraryRoot, "作品"), { recursive: true });
    await mkdir(outside, { recursive: true });
    try {
      await symlink(outside, trashRoot, "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    await expect(listTrashEntries(libraryRoot, trashRoot, "novel-test")).rejects.toMatchObject({
      statusCode: 403,
      code: "SYMLINK_TARGET_FORBIDDEN"
    });
  });

  it("rejects pathological chapter-number spans instead of enumerating them", async () => {
    const projectRoot = resolve(await temporaryRoot(), "project");
    await mkdir(resolve(projectRoot, "正文"), { recursive: true });
    await writeFile(resolve(projectRoot, "正文", "第001章.md"), "第一章", "utf8");
    await writeFile(resolve(projectRoot, "正文", "第999999章.md"), "远端章节", "utf8");
    await expect(exportBookMarkdown(projectRoot, "测试小说")).rejects.toMatchObject({ statusCode: 422 });
  });

  it("bounds directory depth before a scan can grow without files", async () => {
    const projectRoot = resolve(await temporaryRoot(), "project");
    let nested = projectRoot;
    for (let depth = 0; depth < 4; depth += 1) {
      nested = resolve(nested, `level-${depth}`);
      await mkdir(nested, { recursive: true });
    }
    await expect(collectFilesInside(projectRoot, projectRoot, { maxDepth: 2 })).rejects.toMatchObject({
      statusCode: 413,
      code: "SCAN_DEPTH_LIMIT"
    });
  });

  it("allows only one concurrent restore of the same entry", async () => {
    const root = await temporaryRoot();
    const libraryRoot = resolve(root, "library");
    const trashRoot = resolve(libraryRoot, ".trash");
    const projectRoot = resolve(libraryRoot, "作品", "novel-test");
    const trashed = resolve(trashRoot, "files", "novel-test", "stamp", "正文", "第001章.md");
    await mkdir(resolve(trashed, ".."), { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await writeFile(trashed, "旧正文", "utf8");
    const [entry] = await listTrashEntries(libraryRoot, trashRoot, "novel-test");

    const outcomes = await Promise.allSettled([
      restoreTrashEntry(libraryRoot, trashRoot, projectRoot, "novel-test", entry.id),
      restoreTrashEntry(libraryRoot, trashRoot, projectRoot, "novel-test", entry.id)
    ]);

    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
  });
});
