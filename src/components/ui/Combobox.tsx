"use client";

import { ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ComboboxOption {
  value: string;
  label: string;
  color?: string;
  adornment?: ReactNode;
}

interface SharedProps {
  options: ComboboxOption[];
  label: string;
  disabled?: boolean;
  searchThreshold?: number;
  panelClassName?: string;
  triggerClassName?: string;
  emptyOption?: string;
}

interface SingleProps extends SharedProps {
  multiple?: false;
  value: string;
  onChange: (value: string) => void;
  children: (selected: ComboboxOption | undefined) => ReactNode;
}

interface MultiProps extends SharedProps {
  multiple: true;
  value: string[];
  onChange: (value: string[]) => void;
  children: (selected: ComboboxOption[]) => ReactNode;
}

type ComboboxProps = SingleProps | MultiProps;

const PANEL_WIDTH = 224;
const PANEL_MAX_HEIGHT = 260;

export function Combobox(props: ComboboxProps) {
  const {
    options,
    label,
    disabled,
    searchThreshold = 8,
    panelClassName = "",
    triggerClassName = "",
    emptyOption,
  } = props;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const listboxId = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const picked = useMemo(
    () => (props.multiple ? props.value : props.value ? [props.value] : []),
    [props.multiple, props.value],
  );
  const pickedSet = useMemo(() => new Set(picked), [picked]);

  const rows = useMemo<ComboboxOption[]>(
    () => (emptyOption ? [{ value: "", label: emptyOption }, ...options] : options),
    [emptyOption, options],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? rows.filter((o) => o.label.toLowerCase().includes(q)) : rows;
  }, [rows, query]);

  const showSearch = options.length >= searchThreshold;

  function close() {
    setOpen(false);
    setQuery("");
    anchor.current?.focus();
  }

  function pick(option: ComboboxOption) {
    if (props.multiple) {
      if (!option.value) {
        props.onChange([]);
        return;
      }
      props.onChange(
        pickedSet.has(option.value)
          ? picked.filter((v) => v !== option.value)
          : [...picked, option.value],
      );
      return;
    }
    props.onChange(option.value);
    close();
  }

  const selectedIndex = rows.findIndex((o) => pickedSet.has(o.value));
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = anchor.current?.getBoundingClientRect();
    if (!trigger) {
      setRect(null);
      return;
    }
    const inner = anchor.current
      ?.querySelector("[data-combobox-anchor]")
      ?.getBoundingClientRect();
    setRect(
      new DOMRect(
        inner?.left ?? trigger.left,
        trigger.top,
        inner?.width ?? trigger.width,
        trigger.height,
      ),
    );
    setActive(Math.max(0, selectedIndexRef.current));
  }, [open]);

  useEffect(() => {
    if (open && rect) (showSearch ? search : list).current?.focus();
  }, [open, rect, showSearch]);

  useEffect(() => {
    if (!open) return;
    function dismiss() {
      if (panel.current?.contains(document.activeElement)) {
        anchor.current?.focus({ preventScroll: true });
      }
      setOpen(false);
      setQuery("");
    }
    function onPointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (anchor.current?.contains(target) || panel.current?.contains(target)) return;
      dismiss();
    }
    function onResize() {
      dismiss();
    }
    let armed = false;
    const arming = requestAnimationFrame(() => (armed = true));
    function onScroll(e: Event) {
      if (!armed) return;
      if (e.target instanceof Node && panel.current?.contains(e.target)) return;
      dismiss();
    }
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      cancelAnimationFrame(arming);
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  function onKeyDown(e: React.KeyboardEvent) {
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

  const below = rect ? window.innerHeight - rect.bottom : 0;
  const flip = rect ? below < PANEL_MAX_HEIGHT && rect.top > below : false;

  const trigger = props.multiple
    ? props.children(options.filter((o) => pickedSet.has(o.value)))
    : props.children(options.find((o) => o.value === props.value));

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
        {trigger}
      </button>

      {open &&
        rect &&
        createPortal(
          <div
            ref={panel}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
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
              ref={list}
              id={`${listboxId}-list`}
              role="listbox"
              aria-label={label}
              aria-multiselectable={props.multiple || undefined}
              tabIndex={-1}
              aria-activedescendant={filtered[active] ? `${listboxId}-${active}` : undefined}
              className="focus-ring-inset max-h-52 overflow-y-auto py-1"
            >
              {filtered.length === 0 && (
                <p className="px-2.5 py-2 text-xs text-text-muted">No matches</p>
              )}
              {filtered.map((option, index) => {
                const on = option.value ? pickedSet.has(option.value) : picked.length === 0;
                return (
                  <button
                    key={option.value || "__empty"}
                    id={`${listboxId}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={on}
                    onMouseEnter={() => setActive(index)}
                    onClick={(e) => {
                      e.stopPropagation();
                      pick(option);
                    }}
                    className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors ${
                      index === active ? "bg-bg-hover text-text" : "text-text-muted"
                    }`}
                  >
                    {option.adornment ??
                      (option.color && (
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: option.color }}
                        />
                      ))}
                    <span className="truncate">{option.label}</span>
                    <svg
                      aria-hidden
                      viewBox="0 0 16 16"
                      className={`ml-auto h-3.5 w-3.5 shrink-0 text-primary ${on ? "" : "opacity-0"}`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2.25}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M3.5 8.5l3 3 6-7" />
                    </svg>
                  </button>
                );
              })}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
