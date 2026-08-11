"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";

export interface Suggestion {
  id: string;
  /** What replaces the trigger and everything typed after it. */
  insert: string;
  label: string;
  /** Shown beside the label — a full name, a task title. */
  hint?: string;
}

export interface Trigger {
  name: string;
  /**
   * Matched against the text before the caret and therefore anchored with `$`. Group 1 is the
   * query. The whole match is what the insertion replaces, so a trigger may be more than one
   * character — `BP-` as readily as `@`.
   */
  pattern: RegExp;
  suggest: (query: string) => Suggestion[] | Promise<Suggestion[]>;
}

interface Open {
  trigger: string;
  /** Where the match begins, so insertion never has to search backwards for the trigger. */
  start: number;
  caret: number;
}

const MAX_SUGGESTIONS = 10;

/**
 * The autocomplete that used to live inside Comments, as five pieces of state and a lastIndexOf.
 *
 * Generalised on the way out so one mechanism serves both triggers: `@` for people and a project
 * key for tasks. The trigger's own match decides what gets replaced, rather than searching back for
 * a character — with a multi-character trigger, `lastIndexOf` finds the wrong thing as soon as the
 * text contains a second hyphen.
 */
export function useTriggerAutocomplete(
  triggers: Trigger[],
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  onChange: (value: string) => void
) {
  const [open, setOpen] = useState<Open | null>(null);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [index, setIndex] = useState(0);
  // Answers can arrive out of order once a trigger asks the server; only the newest may land
  const request = useRef(0);
  // What the last detection was looking at, so a trigger whose data arrives later can be asked
  // again. The people list is fetched on mount: type an `@` before it lands and the list came back
  // empty with nothing to make it look again.
  const last = useRef<{ value: string; caret: number } | null>(null);

  const close = useCallback(() => {
    setOpen(null);
    setItems([]);
    setIndex(0);
    request.current++;
  }, []);

  const detect = useCallback(
    (value: string, caret: number) => {
      last.current = { value, caret };
      const before = value.slice(0, caret);

      for (const trigger of triggers) {
        const match = before.match(trigger.pattern);
        if (!match) continue;

        const ticket = ++request.current;
        setOpen({ trigger: trigger.name, start: caret - match[0].length, caret });
        setIndex(0);

        Promise.resolve(trigger.suggest(match[1] ?? ""))
          .then((found) => {
            if (request.current !== ticket) return;
            setItems(found.slice(0, MAX_SUGGESTIONS));
          })
          .catch(() => {
            if (request.current === ticket) setItems([]);
          });
        return;
      }

      close();
    },
    [triggers, close]
  );

  // Triggers change identity when their data does — the people list arriving, the board key
  // resolving. Anything already typed is re-offered against it.
  useEffect(() => {
    if (last.current) detect(last.current.value, last.current.caret);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggers]);

  const choose = useCallback(
    (suggestion: Suggestion) => {
      const textarea = textareaRef.current;
      if (!open || !textarea) return;

      const value = textarea.value;
      const next = value.slice(0, open.start) + suggestion.insert + " " + value.slice(open.caret);
      onChange(next);
      close();

      // After the state lands, or the browser puts the caret back where React re-rendered it
      const caret = open.start + suggestion.insert.length + 1;
      requestAnimationFrame(() => {
        textarea.selectionStart = textarea.selectionEnd = caret;
        textarea.focus();
      });
    },
    [open, textareaRef, onChange, close]
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // Only while the list is showing something. Enter sends a comment in some composers, and
      // swallowing it whenever a trigger happened to match would take that away.
      if (!open || items.length === 0) return;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setIndex((i) => Math.min(i + 1, items.length - 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setIndex((i) => Math.max(i - 1, 0));
      } else if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        choose(items[index]);
      } else if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    },
    [open, items, index, choose, close]
  );

  return {
    /** Null unless a trigger matched; carries which one, so a caller can style per trigger. */
    trigger: open?.trigger ?? null,
    items,
    index,
    setIndex,
    detect,
    choose,
    close,
    onKeyDown,
  };
}
