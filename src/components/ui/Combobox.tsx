"use client";

import { ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ComboboxOption {
  value: string;
  label: string;
  /** Drawn as a dot before the label, for options that carry a colour */
  color?: string;
}

interface ComboboxProps {
  value: string;
  options: ComboboxOption[];
  onChange: (value: string) => void;
  /** The closed state; gets the selected option, or undefined when nothing matches */
  children: (selected: ComboboxOption | undefined) => ReactNode;
  /** Accessible name for the trigger */
  label: string;
  disabled?: boolean;
  /** Fewer options than this and the search box is only in the way */
  searchThreshold?: number;
  panelClassName?: string;
  triggerClassName?: string;
}

const PANEL_WIDTH = 224;
const PANEL_MAX_HEIGHT = 260;

export function Combobox({
  value,
  options,
  onChange,
  children,
  label,
  disabled,
  searchThreshold = 8,
  panelClassName = "",
  triggerClassName = "",
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const listboxId = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.value === value);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);

  const showSearch = options.length >= searchThreshold;

  function close() {
    setOpen(false);
    setQuery("");
    anchor.current?.focus();
  }

  function pick(option: ComboboxOption) {
    onChange(option.value);
    close();
  }

  // Keyed on `open` alone: every call site builds its options inline, so depending on
  // them would reset the highlight and re-measure on each parent render — the board
  // polls every ten seconds, which would snap the selection back mid-keyboard-nav
  const selectedIndex = options.findIndex((o) => o.value === value);
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;

  // Measured before paint so the panel never shows at the wrong place first
  useLayoutEffect(() => {
    if (!open) return;
    setRect(anchor.current?.getBoundingClientRect() ?? null);
    setActive(Math.max(0, selectedIndexRef.current));
  }, [open]);

  useEffect(() => {
    if (open) (showSearch ? search : panel).current?.focus();
  }, [open, showSearch]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (anchor.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(false);
      setQuery("");
    }
    // The panel is fixed to the viewport, so anything that moves the trigger has to
    // close it rather than leave it floating somewhere wrong. Its own option list is
    // not that: a capture-phase listener sees scrolls from every descendant.
    function onReflow(e: Event) {
      if (e.target instanceof Node && panel.current?.contains(e.target)) return;
      setOpen(false);
      setQuery("");
    }
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [open]);

  function onKeyDown(e: React.KeyboardEvent) {
    // Everything typed into an open dropdown belongs to it. The board listens for
    // bare keys on document — without this, "n" opens the new-task modal while a
    // picker with fewer than eight options (so no search box) has focus.
    e.stopPropagation();

    if (e.key === "Escape") {
      close();
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      if (filtered.length) setActive(e.key === "Home" ? 0 : filtered.length - 1);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!filtered.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + filtered.length) % filtered.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const option = filtered[active];
      if (option) pick(option);
    }
    if (e.key === "Tab") close();
  }

  // Flipped above the trigger when the viewport has no room below it
  const below = rect ? window.innerHeight - rect.bottom : 0;
  const flip = rect ? below < PANEL_MAX_HEIGHT && rect.top > below : false;

  return (
    <>
      <button
        ref={anchor}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={`${listboxId}-list`}
        aria-label={label}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={`focus-ring ${triggerClassName}`}
      >
        {children(selected)}
      </button>

      {open &&
        rect &&
        createPortal(
          <div
            ref={panel}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            // A portal escapes the DOM but not the React tree: without this, clicking
            // the search box bubbles into whatever row the trigger sits in
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
            // The highlight lives on `active`, but focus stays on the panel or the
            // search box — without this a screen reader announces nothing as it moves
            aria-activedescendant={
              filtered[active] ? `${listboxId}-${active}` : undefined
            }
            style={{
              position: "fixed",
              left: Math.max(8, Math.min(rect.left, window.innerWidth - PANEL_WIDTH - 8)),
              top: flip ? undefined : rect.bottom + 4,
              bottom: flip ? window.innerHeight - rect.top + 4 : undefined,
              width: PANEL_WIDTH,
            }}
            className={`z-50 overflow-hidden rounded-lg border border-border bg-bg-card shadow-lg ${panelClassName}`}
          >
            {showSearch && (
              <input
                ref={search}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                placeholder="Search…"
                aria-label={`Search ${label}`}
                className="w-full border-b border-border bg-transparent px-2.5 py-2 text-xs text-text outline-none placeholder:text-text-muted"
              />
            )}
            <div
              id={`${listboxId}-list`}
              role="listbox"
              aria-label={label}
              className="max-h-52 overflow-y-auto py-1"
            >
              {filtered.length === 0 && (
                <p className="px-2.5 py-2 text-xs text-text-muted">No matches</p>
              )}
              {filtered.map((option, index) => (
                <button
                  key={option.value}
                  id={`${listboxId}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  onMouseEnter={() => setActive(index)}
                  onClick={(e) => {
                    e.stopPropagation();
                    pick(option);
                  }}
                  className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors ${
                    index === active ? "bg-bg-hover text-text" : "text-text-muted"
                  }`}
                >
                  {option.color && (
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: option.color }}
                    />
                  )}
                  <span className="truncate">{option.label}</span>
                  {option.value === value && <span className="ml-auto text-primary">✓</span>}
                </button>
              ))}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
