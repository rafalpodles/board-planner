// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { OWNS_ITS_KEYS, isTypingTarget, ownsItsKeys } from "./keyboard-scope";

afterEach(() => {
  document.body.innerHTML = "";
});

function mount(html: string) {
  document.body.innerHTML = html;
  return (id: string) => document.getElementById(id);
}

describe("ownsItsKeys", () => {
  it("claims the marked element itself", () => {
    const at = mount(`<div id="panel" ${OWNS_ITS_KEYS}></div>`);
    expect(ownsItsKeys(at("panel"))).toBe(true);
  });

  it("claims anything nested inside it, however deep", () => {
    const at = mount(
      `<div ${OWNS_ITS_KEYS}><div><button id="send">Send</button></div></div>`
    );
    expect(ownsItsKeys(at("send"))).toBe(true);
  });

  it("leaves the rest of the page alone", () => {
    const at = mount(`<div ${OWNS_ITS_KEYS}></div><button id="card">A card</button>`);
    expect(ownsItsKeys(at("card"))).toBe(false);
  });

  // A keydown on a page with nothing focused reports `document.body`, and `document` itself has no
  // `closest` — neither may throw the handler that asks
  it("says no for the body, the document and nothing at all", () => {
    mount(`<div ${OWNS_ITS_KEYS}></div>`);
    expect(ownsItsKeys(document.body)).toBe(false);
    expect(ownsItsKeys(document)).toBe(false);
    expect(ownsItsKeys(null)).toBe(false);
  });
});

describe("isTypingTarget", () => {
  it.each(["input", "textarea", "select"])("says yes for a %s", (tag) => {
    const at = mount(`<${tag} id="field"></${tag}>`);
    expect(isTypingTarget(at("field"))).toBe(true);
  });

  // BP-656: the half the board's copy of this rule was missing. The docs promise the keys type
  // rather than fire in "anything editable", and this is what makes that sentence true.
  it("says yes for a contentEditable element", () => {
    const at = mount(`<div id="rich" contenteditable="true"></div>`);
    expect(isTypingTarget(at("rich"))).toBe(true);
  });

  it("leaves a button, the body, the document and nothing at all alone", () => {
    const at = mount(`<button id="card">A card</button>`);
    expect(isTypingTarget(at("card"))).toBe(false);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isTypingTarget(document)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
