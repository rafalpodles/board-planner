"use client";

import { useState } from "react";
import { Input } from "./Input";
import { Button } from "./Button";

interface SecretFieldProps {
  /** The masked value from the API. The real one never reaches the client. */
  masked: string;
  label: string;
  placeholder?: string;
  /** Return false to refuse: the field keeps what was typed */
  onReplace: (value: string) => boolean | void | Promise<boolean | void>;
  disabled?: boolean;
}

export function SecretField({
  masked,
  label,
  placeholder,
  onReplace,
  disabled,
}: SecretFieldProps) {
  const [replacing, setReplacing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!value.trim()) return;
    setBusy(true);
    try {
      // Clearing regardless threw away the URL whenever the caller refused
      if ((await onReplace(value.trim())) !== false) {
        setValue("");
        setReplacing(false);
      }
    } finally {
      setBusy(false);
    }
  }

  if (!replacing) {
    return (
      <div className="flex items-center gap-2">
        <code
          className="min-w-0 flex-1 truncate rounded bg-bg-input px-2 py-1 text-xs text-text-muted"
          title={label}
        >
          {masked || "Not set"}
        </code>
        <Button variant="secondary" size="sm" disabled={disabled} onClick={() => setReplacing(true)}>
          Replace
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        autoFocus
        value={value}
        aria-label={label}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") {
            setValue("");
            setReplacing(false);
          }
        }}
      />
      <Button size="sm" disabled={busy || !value.trim()} onClick={submit}>
        Save
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() => {
          setValue("");
          setReplacing(false);
        }}
      >
        Cancel
      </Button>
    </div>
  );
}
