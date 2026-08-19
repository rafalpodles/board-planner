import { describe, it, expect } from "vitest";
import { renderEmail, pillToneForRole, safeUrl } from "@/lib/email-template";

const MINIMAL = {
  preheader: "preheader",
  kicker: "Kicker",
  footer: ["because you asked"],
};

describe("renderEmail", () => {
  it("carries every link the HTML has into the text part", () => {
    const { text } = renderEmail({
      ...MINIMAL,
      heading: "Set a new password",
      taskCard: {
        key: "BP-142",
        title: "Session cookie survives a password change",
        url: "https://app.example.com/projects/BP/tasks/142",
      },
      button: { label: "Open BP-142", url: "https://app.example.com/projects/BP/tasks/142" },
      footerLinks: [{ label: "Settings", url: "https://app.example.com/settings/profile" }],
    });

    expect(text).toContain("https://app.example.com/projects/BP/tasks/142");
    expect(text).toContain("Open BP-142: https://app.example.com/projects/BP/tasks/142");
    expect(text).toContain("Settings: https://app.example.com/settings/profile");
  });

  // The old callers passed `text` alone and sendEmail used it as the HTML body, so a mail client
  // collapsed every newline and glued separate sentences together.
  it("keeps the text part free of markup and the paragraphs apart", () => {
    const { text } = renderEmail({
      ...MINIMAL,
      intro: ["First sentence.", "Second sentence."],
      outro: ["Closing note."],
    });

    expect(text).not.toMatch(/<[a-z/]/i);
    expect(text).toContain("First sentence.\n\nSecond sentence.");
    expect(text).toContain("\n\nClosing note.");
  });

  it("escapes content that arrived from the database", () => {
    const { html, text } = renderEmail({
      ...MINIMAL,
      taskCard: { key: "BP-1", title: `<img src=x onerror="alert(1)">` },
      quote: { who: "rafal", text: "<script>steal()</script>" },
    });

    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;steal()&lt;/script&gt;");
    expect(text).toContain("<script>steal()</script>");
  });

  it("drops a link that is not http(s) rather than rendering it", () => {
    const { html, text } = renderEmail({
      ...MINIMAL,
      button: { label: "Open", url: "javascript:alert(1)" },
      taskCard: { key: "BP-1", title: "Task", url: "javascript:alert(1)" },
      footerLinks: [{ label: "Settings", url: "data:text/html,hi" }],
    });

    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text/html");
    expect(text).not.toContain("javascript:");
    expect(text).not.toContain("Open:");
  });

  it("hides the preheader from the body while leaving it in the source", () => {
    const { html } = renderEmail({ ...MINIMAL, preheader: "The link expires in an hour." });

    expect(html).toContain("The link expires in an hour.");
    expect(html).toMatch(/display:none[^>]*>The link expires in an hour\./);
  });

  it("shows the button target as text only when asked", () => {
    const url = "https://app.example.com/reset?token=abc";
    const withFallback = renderEmail({
      ...MINIMAL,
      button: { label: "Reset", url },
      showButtonUrl: true,
    });
    const without = renderEmail({ ...MINIMAL, button: { label: "Reset", url } });

    expect(withFallback.html).toContain("Or paste this into your browser");
    expect(without.html).not.toContain("Or paste this into your browser");
  });

  it("renders a transition as two pills with an arrow between them", () => {
    const { html, text } = renderEmail({
      ...MINIMAL,
      taskCard: {
        key: "BP-142",
        title: "Task",
        pills: [{ label: "In Progress", tone: "progress" }, "arrow", { label: "In Review", tone: "review" }],
      },
    });

    expect(html).toContain("In Progress");
    expect(html).toContain("&rarr;");
    expect(html).toContain("In Review");
    expect(text).toContain("BP-142 · In Progress → In Review");
  });

  it("styles both colour schemes rather than one", () => {
    const { html } = renderEmail(MINIMAL);

    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).toContain(`content="light dark"`);
  });
});

describe("pillToneForRole", () => {
  it("maps every column role, and an unknown one to neutral", () => {
    expect(pillToneForRole("approved")).toBe("todo");
    expect(pillToneForRole("active")).toBe("progress");
    expect(pillToneForRole("review")).toBe("review");
    expect(pillToneForRole("blocked")).toBe("human");
    expect(pillToneForRole("done")).toBe("done");
    expect(pillToneForRole("backlog")).toBe("neutral");
    expect(pillToneForRole(undefined)).toBe("neutral");
  });
});

describe("safeUrl", () => {
  it("accepts http and https and nothing else", () => {
    expect(safeUrl("https://app.example.com/x")).toBe("https://app.example.com/x");
    expect(safeUrl("http://localhost:3000/x")).toBe("http://localhost:3000/x");
    expect(safeUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeUrl("/projects/BP/tasks/1")).toBeUndefined();
    expect(safeUrl(undefined)).toBeUndefined();
  });
});
