import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApiError,
  assertNoSymlinkEscape,
  exportBookMarkdown,
  exportProjectZip,
  listDocumentVersions,
  listTrashEntries,
  previewVersionDiff,
  restoreDocumentVersion,
  restoreTrashEntry,
  revisionOf,
  saveHistoryVersion
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
    await writeFile(trashed, "旧正文", "utf8");
    const [entry] = await listTrashEntries(libraryRoot, trashRoot, "novel-test");
    expect(entry.path).toBe("正文/第001章.md");
    await writeFile(target, "当前正文", "utf8");
    await expect(restoreTrashEntry(trashRoot, projectRoot, "novel-test", entry.id)).rejects.toMatchObject({ statusCode: 409 });
    await rm(target);
    await expect(restoreTrashEntry(trashRoot, projectRoot, "novel-test", entry.id)).resolves.toEqual({ restored: true, path: "正文/第001章.md" });
  });
});

describe("exports and path safety", () => {
  it("orders chapters, reports gaps, and excludes secrets and logs from ZIP", async () => {
    const projectRoot = resolve(await temporaryRoot(), "project");
    await mkdir(resolve(projectRoot, "正文"), { recursive: true });
    await mkdir(resolve(projectRoot, ".history", "test"), { recursive: true });
    await writeFile(resolve(projectRoot, "正文", "第003章.md"), "# 第003章\n", "utf8");
    await writeFile(resolve(projectRoot, "正文", "第001章.md"), "# 第001章\n", "utf8");
    await writeFile(resolve(projectRoot, ".history", "test", "old.md"), "历史", "utf8");
    await writeFile(resolve(projectRoot, ".env"), "SECRET=never", "utf8");
    await writeFile(resolve(projectRoot, "server.log"), "private log", "utf8");
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
    expect(zipBytes.includes(Buffer.from("private log"))).toBe(false);
  });

  it("rejects a directory symlink that escapes the project", async () => {
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
  });
});
