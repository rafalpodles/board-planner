"use client";

const SEARCH_ICON = "M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z";

function SearchIcon({ className }: { className: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d={SEARCH_ICON} />
    </svg>
  );
}

/** Field-shaped, so the sidebar still reads as having a search box — but it only opens the layer */
export function SearchTrigger({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="px-2.5 pb-2.5">
      <button
        type="button"
        onClick={onOpen}
        aria-label="Search tasks and projects"
        aria-keyshortcuts="Meta+K Control+K"
        className="focus-ring flex h-[44px] w-full items-center gap-2 rounded-lg border border-border bg-bg-input py-2 pl-3 pr-3 text-left text-[13px] text-text-muted transition-colors hover:bg-bg-hover md:h-auto"
      >
        <SearchIcon className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">Search tasks and projects</span>
        <kbd className="shrink-0 rounded border border-border bg-bg-card px-1 py-0.5 font-mono text-[10px] text-text-muted">
          ⌘K
        </kbd>
      </button>
    </div>
  );
}

export function SearchIconButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Search tasks and projects"
      className="focus-ring flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-text"
    >
      <SearchIcon className="h-5 w-5" />
    </button>
  );
}
