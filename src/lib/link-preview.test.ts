import { describe, expect, it } from "vitest";
import { taskLinkPreviewTitle } from "./link-preview";

describe("taskLinkPreviewTitle", () => {
  it("names the task by the key its URL spells, upper-cased as the board shows it", () => {
    expect(taskLinkPreviewTitle("CRA", "164")).toBe("CRA-164 — Board Planner");
    expect(taskLinkPreviewTitle("cra", "164")).toBe("CRA-164 — Board Planner");
  });

  it("names nothing for a URL that addresses the task by id, since an id is not a key", () => {
    expect(taskLinkPreviewTitle("69a52e3b399b27d3cbb2c5a5", "164")).toBeNull();
    expect(taskLinkPreviewTitle("CRA", "6ad0b883588304eb357cfa86")).toBeNull();
  });

  it("names nothing for a segment that is no key or number, so a crafted URL cannot write the preview", () => {
    expect(taskLinkPreviewTitle("CRA", "0")).toBeNull();
    expect(taskLinkPreviewTitle("CRA", "1 Pay now")).toBeNull();
    expect(taskLinkPreviewTitle("Pay now at evil", "1")).toBeNull();
  });
});
