import { useEffect, useRef } from "react";
import { markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
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
            }
          }
        }),
        markdown(),
        annotationMarks,
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ spellcheck: "false", "aria-label": "小说正文编辑器" }),
        keymap.of([]),
        modeCompartment.of(modeExtensions(mode)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
        EditorView.theme({
          "&": { height: "100%", backgroundColor: "transparent" },
          ".cm-scroller": {
            fontFamily: '"Noto Serif SC", "Songti SC", SimSun, serif',
            fontSize: "16px",
            lineHeight: "1.9",
            overflow: "auto"
          },
          ".cm-content": { padding: "22px 32px 70px 18px", caretColor: "#2563eb" },
          ".cm-line": { padding: "0 8px" },
          ".cm-gutters": {
            backgroundColor: "transparent",
            borderRight: "1px solid var(--workbench-line)",
            color: "#9ca3af",
            minWidth: "62px"
          },
          ".cm-lineNumbers .cm-gutterElement": {
            cursor: "pointer",
            padding: "0 15px 0 10px",
            minWidth: "54px"
          },
          ".cm-lineNumbers .cm-gutterElement:hover": { color: "#2563eb", backgroundColor: "#eff6ff" },
          ".cm-activeLine": { backgroundColor: "rgba(37, 99, 235, .055)" },
          ".cm-activeLineGutter": { backgroundColor: "rgba(37, 99, 235, .09)", color: "#2563eb" },
          ".cm-annotation-line": { backgroundColor: "rgba(37, 99, 235, .075)" },
          ".cm-annotation-selected": { backgroundColor: "rgba(37, 99, 235, .14)" },
          ".cm-selectionBackground, ::selection": { backgroundColor: "rgba(37, 99, 235, .18) !important" },
          ".cm-focused": { outline: "none" }
        })
      ]
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
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
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
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

function modeExtensions(mode: WorkspaceMode) {
  const editable = mode === "edit";
  return [EditorState.readOnly.of(!editable), EditorView.editable.of(editable)];
}
