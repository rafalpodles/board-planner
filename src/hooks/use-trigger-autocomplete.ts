"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { caretCoordinates, type CaretPoint } from "@/lib/caret";

export interface Suggestion {
  id: string;
  insert: string;
  label: string;
  hint?: string;
}

export interface Trigger {
  name: string;
  pattern: RegExp;
  suggest: (query: string) => Suggestion[] | Promise<Suggestion[]>;
}

interface Open {
  trigger: string;
  start: number;
  caret: number;
}

const MAX_SUGGESTIONS = 10;

export function useTriggerAutocomplete(
  triggers: Trigger[],
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  onChange: (value: string) => void
) {
  const [open, setOpen] = useState<Open | null>(null);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [index, setIndex] = useState(0);
  const [at, setAt] = useState<CaretPoint | null>(null);
  const request = useRef(0);
  const last = useRef<{ value: string; caret: number } | null>(null);

  const close = useCallback(() => {
    setOpen(null);
    setItems([]);
    setIndex(0);
    setAt(null);
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
        if (textareaRef.current) setAt(caretCoordinates(textareaRef.current));

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
    [triggers, close, textareaRef]
  );

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
    trigger: open?.trigger ?? null,
    at,
    items,
    index,
    setIndex,
    detect,
    choose,
    close,
    onKeyDown,
  };
}
