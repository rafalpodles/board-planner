// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Switch } from "./Switch";

afterEach(cleanup);

// BP-1033. The hint sits inside the wrapping label, so the control used to be named by label and hint
// together and the same hint was its description: read out twice, and a name nobody searches for.
describe("Switch", () => {
  it("is named by its label and described by its hint, which is said once", () => {
    render(
      <Switch
        checked={false}
        onChange={() => {}}
        label="Sign in with Google"
        hint="People can sign in and link Google."
      />
    );

    const toggle = screen.getByRole("switch", {
      name: "Sign in with Google",
      description: "People can sign in and link Google.",
    });
    expect(toggle).toBeTruthy();
  });

  it("does not take the hint into its name", () => {
    render(<Switch checked onChange={() => {}} label="Enabled" hint="Turns it on for everyone." />);

    expect(screen.queryByRole("switch", { name: /Turns it on/ })).toBeNull();
  });

  it("is named by aria-label when the row already shows the setting's name", () => {
    render(<Switch checked onChange={() => {}} label="Allow writes" labelHidden />);

    expect(screen.getByRole("switch", { name: "Allow writes" })).toBeTruthy();
  });

  it("has no description without a hint", () => {
    render(<Switch checked={false} onChange={() => {}} label="Required" />);

    const toggle = screen.getByRole("switch", { name: "Required" });
    expect(toggle.getAttribute("aria-describedby")).toBeNull();
  });
});
