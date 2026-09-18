// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { OWNS_ITS_KEYS, ownsItsKeys } from "./keyboard-scope";

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
