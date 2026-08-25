import { useEffect, useLayoutEffect, useRef } from "react";

export interface AiRequestHandle {
  controller: AbortController;
  documentKey: string;
  inFlightKey: string;
  requestId: string;
}

export class AiRequestController {
  private documentKey = "";
  private readonly controllers = new Set<AbortController>();
  private readonly inFlightControllers = new Map<string, AbortController>();

  setActiveDocumentKey(next: string) {
    if (next === this.documentKey) return;
    this.abortAll();
    this.documentKey = next;
  }

  start(inFlightKey: string): AiRequestHandle | null {
    if (this.inFlightControllers.has(inFlightKey)) return null;
    const controller = new AbortController();
    this.inFlightControllers.set(inFlightKey, controller);
    this.controllers.add(controller);
    return { controller, documentKey: this.documentKey, inFlightKey, requestId: crypto.randomUUID() };
  }

  isCurrent(handle: AiRequestHandle) {
    return !handle.controller.signal.aborted && handle.documentKey === this.documentKey;
  }

  finish(handle: AiRequestHandle) {
    this.controllers.delete(handle.controller);
    if (this.inFlightControllers.get(handle.inFlightKey) === handle.controller) {
      this.inFlightControllers.delete(handle.inFlightKey);
    }
  }

  abortAll() {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.inFlightControllers.clear();
  }
}

export function useAiRequestController(activeDocumentKey: string) {
  const controllerRef = useRef<AiRequestController | null>(null);
  if (!controllerRef.current) controllerRef.current = new AiRequestController();
  useLayoutEffect(() => controllerRef.current!.setActiveDocumentKey(activeDocumentKey), [activeDocumentKey]);
  useEffect(() => () => controllerRef.current!.abortAll(), []);
  return controllerRef.current;
}
