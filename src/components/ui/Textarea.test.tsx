// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Textarea } from "./Textarea";

afterEach(cleanup);

describe("Textarea uploads (BP-921)", () => {
  it("shows why an upload was refused, and clears it on the next attempt", async () => {
    let refuse = true;
    const upload = async () => {
      if (refuse) throw new Error("This organisation has used 5120 MB of its 5120 MB.");
      return "![ok](/api/uploads/1)";
    };
    render(<Textarea label="Description" onFileUpload={upload} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["x"], "plan.png", { type: "image/png" });

    fireEvent.change(input, { target: { files: [file] } });
    expect((await screen.findByRole("alert")).textContent).toBe("This organisation has used 5120 MB of its 5120 MB.");

    refuse = false;
    fireEvent.change(input, { target: { files: [file] } });
    await screen.findByDisplayValue(/!\[ok\]/);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("names the attach button for a screen reader", () => {
    render(<Textarea onFileUpload={async () => ""} />);
    expect(screen.getByRole("button", { name: "Attach a file" })).toBeTruthy();
  });
});
