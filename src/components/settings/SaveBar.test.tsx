// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { SaveBar } from "./SaveBar";

/**
 * BP-593. The PM launcher is painted over this bar and steps up for anything declaring the bottom
 * strip. Unlike the phone comment bar, this one is always mounted and collapses to `max-h-0`, so
 * it may only declare the strip while it is open — otherwise the launcher would sit raised on
 * every settings page for ever. The launcher's own half is asserted in `PmChatWidget.test.tsx`.
 */

vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const group = {
  id: "general",
  section: "general",
  label: "General",
  count: 1,
  save: vi.fn(),
  discard: vi.fn(),
};

const bar = () => document.querySelector("[data-pinned-save-bar]");

afterEach(cleanup);

describe("SaveBar and the strip below it", () => {
  it("declares the bottom strip while it is open", () => {
    render(<SaveBar pending={[group]} total={1} onGoToSection={vi.fn()} />);

    expect(bar()).not.toBeNull();
  });

  // The reason it is conditional: the bar never unmounts, it collapses
  it("declares nothing once there is nothing to save", () => {
    render(<SaveBar pending={[]} total={0} onGoToSection={vi.fn()} />);

    expect(bar()).toBeNull();
  });
});
