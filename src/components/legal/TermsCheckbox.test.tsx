// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { useState } from "react";
import { useLegalTerms } from "@/hooks/use-legal-terms";
import { TermsCheckbox } from "./TermsCheckbox";

const TERMS = {
  version: "2026-10-15",
  terms: "https://board-planner.com/legal/terms",
  privacy: "https://board-planner.com/legal/privacy",
  termsPl: "https://board-planner.com/legal/terms/pl",
  privacyPl: "https://board-planner.com/legal/privacy/pl",
};

function Form() {
  const terms = useLegalTerms();
  const [checked, setChecked] = useState(false);
  return (
    <form>
      <TermsCheckbox terms={terms} checked={checked} onChange={setChecked} />
      <button type="submit" disabled={terms === undefined}>
        Create
      </button>
    </form>
  );
}

const answer = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the terms box (BP-939)", () => {
  it("shows an unticked, required box once the terms are read, and lets the form go", async () => {
    fetchMock.mockReturnValue(answer(200, { terms: TERMS }));

    render(<Form />);

    const box = (await screen.findByRole("checkbox")) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(box.required).toBe(true);
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("holds the form back while the request is in flight", () => {
    fetchMock.mockReturnValue(new Promise(() => {}));

    render(<Form />);

    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows no box, and lets the form go, where no terms are published", async () => {
    fetchMock.mockReturnValue(answer(200, { terms: null }));

    render(<Form />);

    await vi.waitFor(() => expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
