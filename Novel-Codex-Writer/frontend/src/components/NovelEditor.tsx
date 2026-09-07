import { useEffect, useRef } from "react";
import { markdown } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Compartment, EditorState, StateEffect, StateField, Transaction } from "@codemirror/state";
import { Decoration, EditorView, keymap, lineNumbers, type DecorationSet } from "@codemirror/view";
import type { WorkspaceMode } from "../types";

const setAnnotationMarks = StateEffect.define<DecorationSet>();
const annotationMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setAnnotationMarks)) next = effect.value;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field)
});

const modeCompartment = new Compartment();

export interface AnnotationRevealRequest {
  annotationId: string;
  requestId: number;
}

interface NovelEditorProps {
  value: string;
  mode: WorkspaceMode;
  annotations: Array<{ id: string; fromLine: number; toLine: number }>;
  selectedAnnotationId?: string;
  revealRequest?: AnnotationRevealRequest;
  onChange: (value: string) => void;
  onLineClick: (line: number, shiftKey: boolean) => void;
  onRevealHandled: (requestId: number) => void;
}

export function NovelEditor({
  value,
  mode,
  annotations,
  selectedAnnotationId,
  revealRequest,
  onChange,
  onLineClick,
  onRevealHandled
}: NovelEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>();
  const onChangeRef = useRef(onChange);
  const onLineClickRef = useRef(onLineClick);

  useEffect(() => {
    onChangeRef.current = onChange;
    onLineClickRef.current = onLineClick;
  }, [onChange, onLineClick]);

  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers({
          domEventHandlers: {
            mousedown(view, line, event) {
              event.preventDefault();
              onLineClickRef.current(view.state.doc.lineAt(line.from).number, (event as MouseEvent).shiftKey);
              return true;
            },
            keydown(view, line, event) {
              const keyboardEvent = event as KeyboardEvent;
              if (keyboardEvent.key !== "Enter" && keyboardEvent.key !== " ") return false;
              keyboardEvent.preventDefault();
              onLineClickRef.current(view.state.doc.lineAt(line.from).number, keyboardEvent.shiftKey);
              return true;
            }
          }
        }),
        markdown(),
        history(),
        annotationMarks,
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ spellcheck: "false", "aria-label": "小说正文编辑器" }),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        modeCompartment.of(modeExtensions(mode)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          enhanceLineNumberAccessibility(update.view);
        }),
        EditorView.theme({
          "&": { height: "100%", backgroundColor: "transparent", color: "var(--workbench-text)" },
          ".cm-scroller": {
            fontFamily: '"Noto Serif SC", "Songti SC", SimSun, serif',
            fontSize: "18px",
            lineHeight: "1.9",
            overflow: "auto"
          },
          ".cm-content": { padding: "32px 28px 80px 18px", caretColor: "var(--workbench-blue)" },
          ".cm-line": { padding: "0 8px" },
          ".cm-gutters": {
            backgroundColor: "transparent",
            borderRight: "none",
            color: "var(--workbench-subtle)",
            minWidth: "48px"
          },
          ".cm-lineNumbers .cm-gutterElement": {
            cursor: "pointer",
            padding: "0 10px 0 6px",
            minWidth: "42px"
          },
          ".cm-lineNumbers .cm-gutterElement:hover": { color: "var(--workbench-blue)", backgroundColor: "var(--workbench-blue-soft)" },
          ".cm-activeLine": { backgroundColor: "var(--editor-line)" },
          ".cm-activeLineGutter": { backgroundColor: "var(--editor-line)", color: "var(--workbench-blue)" },
          ".cm-annotation-line": { backgroundColor: "var(--editor-annotation)" },
          ".cm-annotation-selected": { backgroundColor: "var(--editor-selected)" },
          ".cm-selectionBackground, ::selection": { backgroundColor: "var(--editor-selection) !important" },
          ".cm-focused": { outline: "none" }
        })
      ]
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    queueMicrotask(() => enhanceLineNumberAccessibility(view));
    return () => {
      view.destroy();
      viewRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
        annotations: Transaction.addToHistory.of(false)
      });
    }
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: modeCompartment.reconfigure(modeExtensions(mode)) });
  }, [mode]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const marks = [];
    for (const annotation of annotations) {
      const className = annotation.id === selectedAnnotationId ? "cm-annotation-selected" : "cm-annotation-line";
      const end = Math.min(annotation.toLine, view.state.doc.lines);
      for (let lineNumber = Math.max(1, annotation.fromLine); lineNumber <= end; lineNumber += 1) {
        marks.push(Decoration.line({ class: className }).range(view.state.doc.line(lineNumber).from));
      }
    }
    view.dispatch({ effects: setAnnotationMarks.of(Decoration.set(marks, true)) });
  }, [annotations, selectedAnnotationId]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !revealRequest) return;
    const selected = annotations.find((item) => item.id === revealRequest.annotationId);
    if (selected && selected.fromLine >= 1 && selected.fromLine <= view.state.doc.lines) {
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.line(selected.fromLine).from, { y: "center" }) });
    }
    onRevealHandled(revealRequest.requestId);
  }, [annotations, onRevealHandled, revealRequest]);

  return <div ref={hostRef} className="novel-editor h-full min-h-0" />;
}

function enhanceLineNumberAccessibility(view: EditorView) {
  // CodeMirror hides decorative gutters by default. These line numbers are
  // interactive annotation controls, so they must be in the accessibility tree.
  view.dom.querySelector(".cm-gutters")?.removeAttribute("aria-hidden");
  for (const element of view.dom.querySelectorAll<HTMLElement>(".cm-lineNumbers .cm-gutterElement")) {
    if (element.style.visibility === "hidden") continue;
    const lineNumber = element.textContent?.trim();
    if (!lineNumber || !/^\d+$/.test(lineNumber)) continue;
    element.tabIndex = 0;
    element.setAttribute("role", "button");
    element.setAttribute("aria-label", `第 ${lineNumber} 行：创建或选择批注`);
  }
}

function modeExtensions(mode: WorkspaceMode) {
  const editable = mode === "edit";
  return [EditorState.readOnly.of(!editable), EditorView.editable.of(editable)];
}
