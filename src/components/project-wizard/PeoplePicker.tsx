"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useApi } from "@/hooks/use-api";
import type { GrantRelation } from "@/types";
import type { Person } from "./wizard-model";

const MIN_QUERY = 2;
const MAX_RESULTS = 10;
const DEBOUNCE_MS = 200;

interface PeoplePickerProps {
  chosen: { person: Person; relation: GrantRelation }[];
  you: string;
  onAdd: (person: Person) => void;
  onRelation: (personId: string, relation: GrantRelation) => void;
  onRemove: (personId: string) => void;
}

const nameOf = (p: Person) => p.fullName || p.username;

/**
 * The settings card's search, for a board with no id yet. A list of every account does not survive
 * a thousand people, so nothing is shown until two letters are typed, and ten at most come back.
 */
export function PeoplePicker({ chosen, you, onAdd, onRelation, onRemove }: PeoplePickerProps) {
  const api = useApi();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Person[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(-1);
  const asked = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  const trimmed = query.trim();

  useEffect(() => {
    if (trimmed.length < MIN_QUERY) return;
    const ticket = ++asked.current;
    const timer = setTimeout(async () => {
      try {
        const found = (await api.get(
          `/api/projects/setup/people?q=${encodeURIComponent(trimmed)}`
        )) as Person[];
        if (ticket !== asked.current) return;
        setResults(found);
        setFailed(false);
        setActive(-1);
      } catch {
        if (ticket !== asked.current) return;
        setResults(null);
        setFailed(true);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trimmed, api]);

  const chosenIds = new Set(chosen.map((c) => c.person._id));
  const offered =
    trimmed.length >= MIN_QUERY && results ? results.filter((p) => !chosenIds.has(p._id)) : [];
  const open = trimmed.length >= MIN_QUERY && (results !== null || failed);

  function pick(person: Person) {
    onAdd(person);
    setQuery("");
    setResults(null);
    asked.current++;
    input.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" && offered.length > 0) {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, offered.length - 1));
    } else if (e.key === "ArrowUp" && offered.length > 0) {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && query) {
      // Never the form's: Enter in a search is not "Next"
      e.preventDefault();
      if (active >= 0 && offered[active]) pick(offered[active]);
    } else if (e.key === "Escape" && query) {
      e.preventDefault();
      setQuery("");
      setResults(null);
    }
  }

  return (
    <div>
      <label htmlFor={`${listId}-search`} className="mb-1 block text-sm font-medium text-text-muted">
        Who can use this board
      </label>
      <div className="relative">
        <input
          ref={input}
          id={`${listId}-search`}
          type="text"
          role="combobox"
          aria-expanded={open && offered.length > 0}
          aria-controls={`${listId}-list`}
          aria-activedescendant={active >= 0 ? `${listId}-opt-${active}` : undefined}
          aria-autocomplete="list"
          aria-describedby={`${listId}-hint`}
          autoComplete="off"
          value={query}
          placeholder="Add a person by username or name…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          className="focus-ring min-h-[44px] w-full rounded-lg border border-border bg-bg-input px-3 py-2 text-text placeholder:text-text-muted"
        />
        {open && (
          <div
            id={`${listId}-list`}
            role="listbox"
            aria-label="People"
            className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-border bg-bg-card shadow-lg"
          >
            {failed ? (
              <p className="px-3 py-2 text-sm text-danger">Could not search. Try again.</p>
            ) : offered.length === 0 ? (
              <p className="px-3 py-2 text-sm text-text-muted">
                {results && results.length > 0 ? "Already on the list" : "No matches"}
              </p>
            ) : (
              <>
                {offered.map((p, i) => (
                  <button
                    key={p._id}
                    id={`${listId}-opt-${i}`}
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    onClick={() => pick(p)}
                    className={`focus-ring flex min-h-11 w-full items-baseline justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-bg-hover ${
                      i === active ? "bg-bg-hover" : ""
                    }`}
                  >
                    <span>{nameOf(p)}</span>
                    {p.fullName && <small className="font-mono text-xs text-text-muted">{p.username}</small>}
                  </button>
                ))}
                {results && results.length >= MAX_RESULTS && (
                  <p className="border-t border-border px-3 py-2 text-xs text-text-muted">
                    Showing the first {MAX_RESULTS}. Keep typing to narrow the list.
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>
      <p id={`${listId}-hint`} className="mt-1 text-xs text-text-muted">
        Owners can change everything on the board. Members work on tasks and sprints. Instance admins
        always have full access.
      </p>

      <ul className="mt-3 space-y-2">
        <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-border bg-bg-input/30 px-2 py-1.5 sm:grid-cols-[minmax(0,1fr)_130px_40px]">
          <span className="min-w-0 break-words text-sm">
            <b className="font-semibold">{you}</b> <small className="text-xs text-text-muted">you</small>
          </span>
          <span className="px-2.5 text-[13px] text-text-muted sm:col-span-2">Owner</span>
        </li>
        {chosen.map(({ person, relation }) => (
          <li
            key={person._id}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-border bg-bg-input/30 px-2 py-1.5 sm:grid-cols-[minmax(0,1fr)_130px_40px]"
          >
            <span className="min-w-0 break-words text-sm">
              <b className="font-semibold">{nameOf(person)}</b>{" "}
              {person.fullName && <small className="text-xs text-text-muted">{person.username}</small>}
            </span>
            <button
              type="button"
              onClick={() => onRemove(person._id)}
              aria-label={`Remove ${nameOf(person)}`}
              className="focus-ring h-10 w-10 rounded-lg text-text-muted hover:bg-bg-hover hover:text-text sm:order-3"
            >
              ✕
            </button>
            <select
              value={relation}
              aria-label={`Access for ${person.username}`}
              onChange={(e) => onRelation(person._id, e.target.value as GrantRelation)}
              className="focus-ring col-span-2 min-h-11 w-full rounded-lg border border-border bg-bg-input px-2 py-1.5 text-sm text-text sm:order-2 sm:col-span-1 sm:min-h-10"
            >
              <option value="member">Member</option>
              <option value="owner">Owner</option>
            </select>
          </li>
        ))}
      </ul>
    </div>
  );
}
