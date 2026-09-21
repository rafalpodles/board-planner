// @vitest-environment happy-dom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownEditor } from "./MarkdownEditor";

afterEach(cleanup);

function Harness({ initial, previewFirst }: { initial: string; previewFirst?: boolean }) {
  const [value, setValue] = useState(initial);
  return <MarkdownEditor label="Body" value={value} onChange={setValue} previewFirst={previewFirst} />;
}

function mount(initial: string, selection: [number, number] = [initial.length, initial.length]) {
  render(<Harness initial={initial} />);
  const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
  textarea.focus();
  textarea.setSelectionRange(...selection);
  return textarea;
}

const press = (title: string) => fireEvent.click(screen.getByTitle(title));
const selected = (t: HTMLTextAreaElement) => t.value.slice(t.selectionStart, t.selectionEnd);

describe("the inline formats", () => {
  it.each([
    ["Bold (Cmd/Ctrl+B)", "**ship**"],
    ["Italic (Cmd/Ctrl+I)", "_ship_"],
    ["Strikethrough", "~~ship~~"],
    ["Link", "[ship](https://)"],
    ["Inline code", "`ship`"],
  ])("%s wraps the selection and keeps it selected", (title, wrapped) => {
    const textarea = mount("we ship today", [3, 7]);
    press(title);
    expect(textarea.value).toBe(`we ${wrapped} today`);
    expect(selected(textarea)).toBe("ship");
  });

  it.each([
    ["Bold (Cmd/Ctrl+B)", "**bold text**", "bold text"],
    ["Italic (Cmd/Ctrl+I)", "_italic text_", "italic text"],
    ["Strikethrough", "~~struck text~~", "struck text"],
    ["Link", "[link text](https://)", "link text"],
    ["Inline code", "`code`", "code"],
  ])("%s at the caret inserts a placeholder, selected so typing replaces it", (title, inserted, placeholder) => {
    const textarea = mount("run ");
    press(title);
    expect(textarea.value).toBe(`run ${inserted}`);
    expect(selected(textarea)).toBe(placeholder);
  });

  it("Cmd+B does what the Bold button does", () => {
    const textarea = mount("we ship today", [3, 7]);
    fireEvent.keyDown(textarea, { key: "b", metaKey: true });
    expect(textarea.value).toBe("we **ship** today");
  });
});

describe("the line formats", () => {
  it.each([
    ["Heading", "## Scope"],
    ["Bulleted list", "- Scope"],
    ["Task list", "- [ ] Scope"],
    ["Numbered list", "1. Scope"],
  ])("%s at the caret in a line marks the start of that line, not the caret", (title, marked) => {
    const textarea = mount("intro\nScope\noutro", [9, 9]);
    press(title);
    expect(textarea.value).toBe(`intro\n${marked}\noutro`);
  });

  it("a selection inside a line marks the whole line", () => {
    const textarea = mount("hello world", [6, 11]);
    press("Heading");
    expect(textarea.value).toBe("## hello world");
  });

  it.each([
    ["Heading", "## Heading", "Heading"],
    ["Bulleted list", "- list item", "list item"],
    ["Task list", "- [ ] todo item", "todo item"],
    ["Numbered list", "1. list item", "list item"],
  ])("%s on an empty line inserts a placeholder, and selects only the placeholder", (title, inserted, placeholder) => {
    const textarea = mount("intro\n");
    press(title);
    expect(textarea.value).toBe(`intro\n${inserted}`);
    expect(selected(textarea)).toBe(placeholder);
  });

  it("a multi-line selection becomes one item per line", () => {
    const textarea = mount("one\ntwo\nthree", [1, 5]);
    press("Numbered list");
    expect(textarea.value).toBe("1. one\n2. two\nthree");
  });

  it("a selection ending on a line break does not take the line after it", () => {
    const textarea = mount("one\ntwo\nthree", [0, 8]);
    press("Bulleted list");
    expect(textarea.value).toBe("- one\n- two\nthree");
  });
});

describe("the preview", () => {
  it("renders the text, holds the toolbar, and hands the same text back to edit", () => {
    const textarea = mount("## Scope\n**bold**");
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("heading", { name: "Scope" })).toBeTruthy();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect((screen.getByTitle("Bold (Cmd/Ctrl+B)") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(textarea.value);
    expect((screen.getByTitle("Bold (Cmd/Ctrl+B)") as HTMLButtonElement).disabled).toBe(false);
  });

  it("an empty field opens for typing even when the preview comes first", () => {
    render(<Harness initial="" previewFirst />);
    expect(screen.getByRole("textbox")).toBeTruthy();
  });
});
