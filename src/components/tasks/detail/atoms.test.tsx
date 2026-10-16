// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { avatarColorIndex } from "@/lib/avatar-color";
import { Avatar } from "./atoms";

afterEach(cleanup);

function avatar(props: React.ComponentProps<typeof Avatar>) {
  const { container } = render(<Avatar {...props} />);
  return container.firstElementChild as HTMLElement;
}

const background = (el: HTMLElement) => el.getAttribute("style") ?? "";

describe("Avatar colour", () => {
  it("takes its colour from the username, not the display name", () => {
    const el = avatar({ name: "Rafal Podles", username: "rafal" });
    expect(el.textContent).toBe("RP");
    expect(background(el)).toContain(`var(--avatar-${avatarColorIndex("rafal")})`);
  });

  it("gives one username one colour whatever name it is shown under", () => {
    const a = avatar({ name: "Rafal Podles", username: "rafal" });
    const b = avatar({ name: "Claude Code", username: "rafal" });
    const colour = (el: HTMLElement) => /var\(--avatar-\d+\)/.exec(background(el))?.[0];
    expect(colour(a)).toBeDefined();
    expect(colour(a)).toBe(colour(b));
  });

  it("falls back to the name when no username is known", () => {
    const el = avatar({ name: "Deleted user" });
    expect(background(el)).toContain(`var(--avatar-${avatarColorIndex("Deleted user")})`);
  });

  it("stays an empty dashed ring, uncoloured, for nobody", () => {
    const el = avatar({ name: null, username: null });
    expect(el.textContent).toBe("");
    expect(background(el)).not.toContain("--avatar-");
    expect(el.className).toContain("border-dashed");
  });
});
