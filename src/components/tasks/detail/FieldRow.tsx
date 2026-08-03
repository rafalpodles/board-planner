"use client";

import type { ReactNode } from "react";
import { Popover } from "@/components/ui/Popover";

interface FieldRowProps {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  /** Sheet sizing: a 46px row is the smallest comfortable tap target here */
  touch?: boolean;
  align?: "center" | "start";
  /** Set when the row opens a popup, so the row announces itself as one */
  expanded?: boolean;
}

export function FieldRow({
  label,
  children,
  onClick,
  touch = false,
  align = "center",
  expanded,
}: FieldRowProps) {
  const shared = `flex w-full gap-2.5 rounded-lg px-2.5 text-left ${
    touch ? "min-h-[46px] py-2.5" : "py-1.5"
  } ${align === "center" ? "items-center" : "items-start"}`;

  const body = (
    <>
      <span
        className={`w-[86px] shrink-0 text-xs text-text-muted ${align === "start" ? "pt-0.5" : ""}`}
      >
        {label}
      </span>
      <span className="min-w-0 flex-1 text-sm">{children}</span>
    </>
  );

  if (!onClick) {
    return <div className={`${shared} -mx-2.5`}>{body}</div>;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup={expanded === undefined ? undefined : "dialog"}
      aria-expanded={expanded}
      className={`focus-ring -mx-2.5 cursor-pointer transition-colors hover:bg-bg-hover ${shared}`}
    >
      {body}
    </button>
  );
}

/** Value shown when a field holds nothing yet */
export function EmptyValue({ children }: { children: ReactNode }) {
  return <span className="text-text-muted">{children}</span>;
}

interface PickerRowProps {
  label: string;
  value: ReactNode;
  panel: (close: () => void) => ReactNode;
  touch?: boolean;
  align?: "center" | "start";
  width?: string;
}

export function PickerRow({
  label,
  value,
  panel,
  touch = false,
  align = "center",
  width,
}: PickerRowProps) {
  return (
    <Popover
      label={label}
      width={width}
      trigger={({ toggle, open }) => (
        <FieldRow
          label={label}
          onClick={toggle}
          touch={touch}
          align={align}
          expanded={open}
        >
          {value}
        </FieldRow>
      )}
    >
      {({ close }) => panel(close)}
    </Popover>
  );
}

interface OptionItemProps {
  onClick: () => void;
  selected?: boolean;
  children: ReactNode;
}

export function OptionItem({ onClick, selected = false, children }: OptionItemProps) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={`focus-ring flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm
        transition-colors hover:bg-bg-hover ${selected ? "text-text" : "text-text-muted"}`}
    >
      {children}
    </button>
  );
}

export function OptionList({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div role="listbox" aria-label={label}>
      {children}
    </div>
  );
}
