import { Children, cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactNode, type ReactElement } from "react";

export function ActionMenu({ label, icon, children, className = "" }: {
  label: string; icon: ReactNode; children: ReactNode; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const startAtEnd = useRef(false);
  useEffect(() => {
    if (!open) return;
    const items = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    (startAtEnd.current ? items.at(-1) : items[0])?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return <div ref={root} className={`action-menu ${className}`} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }} onKeyDown={(event) => {
    if (event.key === "Escape" && open) {
      event.stopPropagation(); event.preventDefault(); setOpen(false); trigger.current?.focus();
    }
    if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault(); startAtEnd.current = event.key === "ArrowUp"; setOpen(true); return;
    }
    if (open && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const items = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  }}>
    <button ref={trigger} className="toolbar-button menu-trigger" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} aria-controls={id} onClick={() => { startAtEnd.current = false; setOpen(!open); }}>{icon}<span>{label}</span></button>
    {open ? <div ref={panel} id={id} className="menu-popover" role="menu" aria-label={label} onClick={(event) => {
      if (event.target instanceof Element && event.target.closest("button:not(:disabled)")) {
        setOpen(false); trigger.current?.focus();
      }
    }}>{Children.map(children, (child) => {
      if (!isValidElement(child) || child.type !== "button") return child;
      const element = child as ReactElement<Record<string, unknown>>;
      const selected = element.props["aria-pressed"];
      return cloneElement(element, { role: selected === undefined ? "menuitem" : "menuitemradio", tabIndex: -1, "aria-pressed": undefined, "aria-checked": selected });
    })}</div> : null}
  </div>;
}
