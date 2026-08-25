import { useEffect, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { streamChapterReview } from "../lib/api";
import { getLineText, replaceLineRange } from "../lib/format";
import {
  computeChapterReviewVerdict,
  reconcileAnnotationsAfterExternalReplacement,
  reconcileFindingsAfterReplacement
} from "../lib/review";
import type {
  AiEngine,
  ChapterReviewRun,
  DocumentEntry,
  DocumentResponse,
  ReviewSession
} from "../types";
import type { AiRequestController } from "./useAiRequestController";

function errorMessage(caught: unknown) {
  return caught instanceof Error ? caught.message : "发生未知错误";
}

export function useChapterReviewController(input: {
  activeProjectId: string;
  selectedPath: string;
  selectedEntry?: DocumentEntry;
  session?: ReviewSession;
  setSession: Dispatch<SetStateAction<ReviewSession | undefined>>;
  document?: DocumentResponse;
  draftContent: string;
  setDraftContent: Dispatch<SetStateAction<string>>;
  dirty: boolean;
  setRightVisible: Dispatch<SetStateAction<boolean>>;
  aiRequestController: AiRequestController;
  draftVersionRef: MutableRefObject<number>;
  invalidateAll(): void;
  onNotice(message: string): void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setBusy(false);
    setMessage("");
  }, [input.activeProjectId, input.selectedPath]);

  function reset() {
    setBusy(false);
    setMessage("");
  }

  function upsertRun(run: ChapterReviewRun) {
    input.setSession((current) => current ? {
      ...current,
      chapterReviewRuns: [run, ...current.chapterReviewRuns.filter((item) => item.id !== run.id)].slice(0, 20)
    } : current);
  }

  async function run(engine: AiEngine) {
    if (!input.session || !input.document || input.selectedEntry?.groupId !== "chapters") return;
    if (input.dirty) {
      input.onNotice("请先保存当前草稿，再运行整章体检；AI 只审阅已落盘的正文版本。");
      return;
    }
    const inFlightKey = `chapter:${input.session.projectId}:${input.session.documentPath}`;
    const request = input.aiRequestController.start(inFlightKey);
    if (!request) return;
    const draftVersion = input.draftVersionRef.current;
    const requestContent = input.draftContent;
    input.setRightVisible(true);
    setBusy(true);
    setMessage("正在运行本地确定性检查……");
    try {
      await streamChapterReview({
        projectId: input.session.projectId,
        documentPath: input.session.documentPath,
        content: requestContent,
        engine,
        expectedRevision: input.document.revision,
        requestId: request.requestId
      }, (event) => {
        if (!input.aiRequestController.isCurrent(request) || draftVersion !== input.draftVersionRef.current) return;
        setMessage(event.message);
        if (event.run) upsertRun(event.run);
        if (event.type === "error") input.onNotice(event.message);
      }, request.controller.signal);
    } catch (caught) {
      if (request.controller.signal.aborted || draftVersion !== input.draftVersionRef.current) return;
      const failure = errorMessage(caught);
      setMessage(failure);
      input.onNotice(failure);
    } finally {
      const wasCurrent = input.aiRequestController.isCurrent(request)
        && draftVersion === input.draftVersionRef.current;
      input.aiRequestController.finish(request);
      if (wasCurrent) setBusy(false);
    }
  }

  function acceptFinding(id: string) {
    if (!input.session) return;
    const reviewRun = input.session.chapterReviewRuns.find((item) => item.findings.some((finding) => finding.id === id));
    const target = reviewRun?.findings.find((item) => item.id === id);
    if (!reviewRun || !target?.after || !target.before || target.fromLine === undefined || target.toLine === undefined) return;
    const currentText = getLineText(input.draftContent, target.fromLine, target.toLine);
    if (currentText !== target.before) {
      input.setSession((current) => current ? {
        ...current,
        chapterReviewRuns: current.chapterReviewRuns.map((item) => item.id !== reviewRun.id ? item : {
          ...item,
          status: "stale",
          verdict: "stale",
          findings: item.findings.map((finding) => finding.id === id ? { ...finding, status: "stale" } : finding)
        })
      } : current);
      input.onNotice("这条建议对应的原文已经变化，已禁止采用；请重新体检。");
      return;
    }
    const nextDraft = replaceLineRange(input.draftContent, target.fromLine, target.toLine, target.after);
    const insertedLineCount = target.after.split(/\r?\n/).length;
    input.invalidateAll();
    input.setDraftContent(nextDraft);
    input.setSession((current) => current ? {
      ...current,
      annotations: reconcileAnnotationsAfterExternalReplacement(
        current.annotations,
        target.fromLine!,
        target.toLine!,
        insertedLineCount
      ),
      chapterReviewRuns: current.chapterReviewRuns.map((item) => item.id !== reviewRun.id
        ? { ...item, status: "stale" as const, verdict: "stale" as const }
        : {
            ...item,
            status: "stale" as const,
            verdict: "stale" as const,
            findings: reconcileFindingsAfterReplacement(
              item.findings,
              id,
              target.fromLine!,
              target.toLine!,
              insertedLineCount
            )
          })
    } : current);
    input.onNotice("建议已写入草稿；本次整章体检已过期，保存后请重新体检。");
  }

  function dismissFinding(id: string) {
    if (!input.session) return;
    const runWithFinding = input.session.chapterReviewRuns.find((item) =>
      item.findings.some((finding) => finding.id === id)
    );
    const target = runWithFinding?.findings.find((item) => item.id === id);
    if (!runWithFinding || !target) return;
    let reason = "用户判断当前无需修改";
    if (target.severity === "S1" || target.severity === "S2") {
      const dismissal = window.prompt("S1/S2 会阻止审查通过。若这是误报，请填写标记“不适用”的理由：", "");
      if (!dismissal?.trim()) {
        input.onNotice("未填写理由，S1/S2 仍保持待处理状态。");
        return;
      }
      reason = dismissal.trim();
    }
    input.setSession((current) => current ? {
      ...current,
      chapterReviewRuns: current.chapterReviewRuns.map((item) => {
        if (item.id !== runWithFinding.id) return item;
        const findings = item.findings.map((finding) => finding.id === id
          ? { ...finding, status: "dismissed" as const, dismissalReason: reason }
          : finding);
        return {
          ...item,
          verdict: computeChapterReviewVerdict(findings, item.status),
          findings
        };
      })
    } : current);
  }

  return { busy, message, run, acceptFinding, dismissFinding, reset };
}
