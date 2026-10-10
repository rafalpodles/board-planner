// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { useState } from "react";
import { useLegalTerms } from "@/hooks/use-legal-terms";
import { TermsCheckbox, termsUnknown } from "./TermsCheckbox";

const TERMS = {
  version: "2026-10-15",
  terms: "https://board-planner.com/legal/terms",
  privacy: "https://board-planner.com/legal/privacy",
  termsPl: "https://board-planner.com/legal/terms/pl",
  privacyPl: "https://board-planner.com/legal/privacy/pl",
};

function Form() {
  const legal = useLegalTerms();
  const [checked, setChecked] = useState(false);
  return (
    <form>
      <TermsCheckbox legal={legal} checked={checked} onChange={setChecked} />
      <button type="submit" disabled={termsUnknown(legal)}>
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
  it("holds the form back and says so when the terms cannot be read, and shows the box once a retry reads them", async () => {
    fetchMock.mockReturnValueOnce(answer(503, { error: "down" })).mockReturnValueOnce(answer(200, { terms: TERMS }));

    render(<Form />);

    expect(await screen.findByTestId("terms-failed")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => screen.getByRole("button", { name: "Try again" }).click());

    const box = (await screen.findByRole("checkbox")) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(box.required).toBe(true);
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    expect(screen.queryByTestId("terms-failed")).toBeNull();
  });
});
