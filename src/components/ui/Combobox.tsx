"use client";

import {
  ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export interface ComboboxOption {
  value: string;
  label: string;
  /** Drawn as a dot before the label, for options that carry a colour */
  color?: string;
  /** Replaces the colour dot when a row needs more than one — an avatar, priority bars */
  adornment?: ReactNode;
}

interface SharedProps {
  options: ComboboxOption[];
  /** Accessible name for the trigger */
  label: string;
  disabled?: boolean;
  /** Fewer options than this and the search box is only in the way */
  searchThreshold?: number;
  panelClassName?: string;
  triggerClassName?: string;
  /** Offered above the options; picking it clears the field */
  emptyOption?: string;
}

interface SingleProps extends SharedProps {
  multiple?: false;
  value: string;
  onChange: (value: string) => void;
  /** The closed state; gets the selected option, or undefined when nothing matches */
  children: (selected: ComboboxOption | undefined) => ReactNode;
}

interface MultiProps extends SharedProps {
  multiple: true;
  value: string[];
  onChange: (value: string[]) => void;
  /** The closed state; gets every selected option, in the options' own order */
  children: (selected: ComboboxOption[]) => ReactNode;
}

type ComboboxProps = SingleProps | MultiProps;

interface Placement {
  left: number;
  top?: number;
  bottom?: number;
  /** What is actually free on the chosen side, so the panel never runs off either end */
  maxHeight: number;
}

const PANEL_WIDTH = 224;
const PANEL_MAX_HEIGHT = 260;
/** Between the panel and the trigger, and between the panel and whatever bounds it */
const GAP = 4;
const PINNED_BARS = "[data-pinned-bottom-bar],[data-pinned-phone-bar]";
/** The search box's own height, taken out of what is left for the list */
const SEARCH_HEIGHT = 33;

/**
 * The bottom of the space a panel may occupy. A bar pinned to the bottom of the screen says so
 * with `data-pinned-bottom-bar` (or `data-pinned-phone-bar`, which only applies below `lg`) — the
 * same attributes the PM launcher steps around. Measuring against the viewport instead put a
 * flipped panel on top of the settings save bar, over the half that says there are unsaved
 * changes (BP-555).
 */
function floorOfFreeSpace() {
  let floor = document.documentElement.clientHeight;
  const phone = window.matchMedia("(max-width: 1023px)").matches;
  const bars = document.querySelectorAll<HTMLElement>(
    phone ? PINNED_BARS : "[data-pinned-bottom-bar]"
  );
  for (const bar of bars) {
    const r = bar.getBoundingClientRect();
    if (r.height > 0) floor = Math.min(floor, r.top);
  }
  return floor;
}

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
  const [place, setPlace] = useState<Placement | null>(null);
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

  // The clear row is an option like any other, so one keyboard path covers both
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
      // Stays open: picking several labels in a row is the whole point of the mode,
      // and the query survives so a search narrowing to three does not have to be retyped
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

  // Keyed on `open` alone: every call site builds its options inline, so depending on
  // them would reset the highlight and re-measure on each parent render — the board
  // polls every ten seconds, which would snap the selection back mid-keyboard-nav
  const selectedIndex = rows.findIndex((o) => pickedSet.has(o.value));
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;

  // Measured before paint so the panel never shows at the wrong place first.
  //
  // Horizontally the panel lines up with whatever inside the trigger carries
  // `data-combobox-anchor`, falling back to the trigger itself. A rail row makes the
  // whole row the button, label included, so aligning to the button put the list under
  // the field's name instead of under the value it is about to replace. Vertically it
  // still hangs off the trigger, so the panel clears the row rather than the text.
  const measure = useCallback(() => {
    const trigger = anchor.current?.getBoundingClientRect();
    if (!trigger) {
      setPlace(null);
      return;
    }
    const inner = anchor.current
      ?.querySelector("[data-combobox-anchor]")
      ?.getBoundingClientRect();
    const viewport = document.documentElement;
    const floor = floorOfFreeSpace();
    // The settings column scrolls *under* its save bar, so a trigger can itself be behind one.
    // Flipping above such a trigger still lands on the bar; the panel hangs off the floor instead
    const ledge = Math.min(trigger.top, floor);
    const below = floor - trigger.bottom - GAP;
    const above = ledge - GAP * 3;
    // Flipped only when there is genuinely more room above: asking whether the panel fits below
    // and not whether it fits above put its top off the screen on a short window (BP-547)
    const flip = below < PANEL_MAX_HEIGHT && above > below;
    setPlace({
      left: Math.max(
        GAP * 2,
        Math.min(inner?.left ?? trigger.left, viewport.clientWidth - PANEL_WIDTH - GAP * 2)
      ),
      top: flip ? undefined : trigger.bottom + GAP,
      bottom: flip ? viewport.clientHeight - ledge + GAP : undefined,
      maxHeight: Math.max(0, Math.min(PANEL_MAX_HEIGHT, flip ? above : below)),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    measure();
    setActive(Math.max(0, selectedIndexRef.current));
  }, [open, measure]);

  // Two things move under an open panel without the viewport changing: the trigger, whose chips
  // wrap onto a second line as a multiselect is ticked (BP-547), and a pinned bar, which arrives
  // over 200ms of `max-height` — so the floor measured on the opening click is not the one the
  // reader ends up with
  useEffect(() => {
    const trigger = anchor.current;
    if (!open || !trigger || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(trigger);
    for (const bar of document.querySelectorAll(PINNED_BARS)) observer.observe(bar);
    return () => observer.disconnect();
  }, [open, measure]);

  // `rect` rather than `open`: the panel is rendered only once it has been measured, which
  // is a commit later than the one that set `open`, so keying on `open` alone focused
  // nothing at all on a first open and left the arrows on the trigger.
  //
  // The listbox rather than the panel around it: the wrapper carries the position and the
  // pointer-event stoppers but no role and no name, so focusing it announced nothing where
  // the trigger it took focus from had announced "…, combo box, expanded".
  useEffect(() => {
    if (open && place) (showSearch ? search : list).current?.focus();
  }, [open, place, showSearch]);

  useEffect(() => {
    if (!open) return;
    // The panel is about to be unmounted from under whatever holds focus inside it, and
    // `document.activeElement` would fall back to the body — the next Tab restarting at the
    // top of the document. `preventScroll` because the reason for two of these three calls
    // is that the trigger has just moved, and scrolling back to it would fight the gesture.
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
    // Re-placed rather than dismissed: on Android the on-screen keyboard is a viewport resize, and
    // a picker with a search box raises it by focusing that box — so closing here shut the picker
    // on the tap that opened it (BP-547)
    function onResize() {
      measure();
    }
    // The panel is fixed to the viewport, so anything that moves the trigger has to close
    // it rather than leave it floating somewhere wrong. Its own option list is not that: a
    // capture-phase listener sees scrolls from every descendant.
    //
    // Not before the next frame, though. A scroll event is delivered at the next rendering
    // opportunity rather than when the scrolling happened, so a scroll applied shortly before
    // the click — a `scrollIntoView`, a settling smooth scroll, the tail of a momentum one —
    // arrives after the click that opened the panel, and closed it again on that same click
    // (BP-532). Those events are dispatched in the rendering cycle whose animation-frame
    // callbacks run after them, so a frame is the gap. Animated scrolls are the exception and
    // want no gap: they keep emitting, so the panel closes on the next frame, which is right.
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
  }, [open, measure]);

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
        place &&
        createPortal(
          <div
            ref={panel}
            // Its border is the one part of the panel that belongs to neither the search box
            // nor the listbox: without this, clicking it puts focus on the body, where the
            // arrows scroll the page and the scroll then dismisses the picker
            tabIndex={-1}
            onKeyDown={onKeyDown}
            // A portal escapes the DOM but not the React tree: without this, clicking
            // the search box bubbles into whatever row the trigger sits in
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
            style={{
              position: "fixed",
              left: place.left,
              top: place.top,
              bottom: place.bottom,
              width: PANEL_WIDTH,
              maxHeight: place.maxHeight,
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
              // Focused when there is no search box, so the keys land on the element whose role
              // and name describe what they do. The highlight lives on `active` rather than on
              // focus — without the activedescendant a screen reader announces nothing as it
              // moves. The search branch focuses the input instead and is not wired up: BP-547.
              tabIndex={-1}
              aria-activedescendant={filtered[active] ? `${listboxId}-${active}` : undefined}
              // The ring is drawn inside its own box: the panel around it is `overflow-hidden`,
              // which crops an offset outline exactly as it crops anything else
              // The panel's own cap is what is free where it landed, and the search box shares it
              style={{ maxHeight: place.maxHeight - (showSearch ? SEARCH_HEIGHT : 0) }}
              className="focus-ring-inset overflow-y-auto py-1"
            >
              {filtered.length === 0 && (
                <p className="px-2.5 py-2 text-xs text-text-muted">No matches</p>
              )}
              {filtered.map((option, index) => {
                // The clear row reads as selected only while nothing else is
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
                    {/* Reserved rather than conditional, so the labels do not shift as
                        the tick appears and disappears under the cursor. Drawn rather
                        than typed: a "✓" character would join every option's
                        textContent, selected or not, and be read out with the label */}
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
