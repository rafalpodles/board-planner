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
    const wanted = `var(--avatar-${avatarColorIndex("rafal")})`;
    expect(avatarColorIndex("Ann")).not.toBe(avatarColorIndex("rafal"));
    expect(background(avatar({ name: "Rafal Podles", username: "rafal" }))).toContain(wanted);
    expect(background(avatar({ name: "Ann", username: "rafal" }))).toContain(wanted);
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
