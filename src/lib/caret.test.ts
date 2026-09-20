// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { caretCoordinates } from "./caret";

/**
 * **What these tests can and cannot reach.** happy-dom parses and styles but does not lay out, so
 * `offsetTop` and `offsetLeft` are always 0 — the pixel arithmetic this module exists for needs a
 * real engine and is exercised by the browser suite, not here. Measured, not assumed: the first
 * test below asserts that zero rather than working around it.
 *
 * What is reachable is everything around the measurement: the mirror is built, populated and
 * removed; the scroll offsets are subtracted; the line height falls back the way it says it does.
 * Those are where the leaks and the NaNs live.
 */

function textarea(
  value: string,
  { caret = value.length, styles = {} as Record<string, string>, scrollTop = 0, scrollLeft = 0 } = {}
) {
  const element = document.createElement("textarea");
  element.value = value;
  element.selectionStart = caret;
  element.selectionEnd = caret;
  for (const [property, setting] of Object.entries(styles)) {
    element.style.setProperty(property, setting);
  }
  Object.defineProperty(element, "scrollTop", { value: scrollTop, writable: true });
  Object.defineProperty(element, "scrollLeft", { value: scrollLeft, writable: true });
  document.body.appendChild(element);
  return element;
}

const mirrors = () => document.querySelectorAll("div");

afterEach(() => {
  document.body.innerHTML = "";
});

describe("caretCoordinates", () => {
  it("measures from the layout engine, which in this environment puts everything at zero", () => {
    expect(caretCoordinates(textarea("hello"))).toMatchObject({ top: 0, left: 0 });
  });

  /**
   * The mirror is built on every keystroke while a suggestion list is open. One left behind is a
   * hidden, absolutely-positioned copy of the field's whole text, added again on the next
   * character — so the leak grows with typing speed rather than staying constant.
   */
  it("leaves no mirror behind", () => {
    caretCoordinates(textarea("hello"));
    caretCoordinates(textarea("hello again"));

    expect(mirrors()).toHaveLength(0);
  });

  // The caret can be on a line the field has scrolled past, so the offsets are relative to the
  // textarea's own box rather than to its content.
  it("subtracts the field's scroll from both axes", () => {
    const point = caretCoordinates(textarea("hello", { scrollTop: 40, scrollLeft: 12 }));

    expect(point).toMatchObject({ top: -40, left: -12 });
  });

  describe("the line height a caller places something below", () => {
    it("reads the computed line height", () => {
      const point = caretCoordinates(textarea("hello", { styles: { "line-height": "27px" } }));

      expect(point.lineHeight).toBe(27);
    });

    /**
     * `normal` is what a field with no line-height set computes to, and `parseInt` answers NaN for
     * it — which would place the suggestion list at `NaN` pixels and render it at the top of the
     * page. The font size times 1.2 is the browser's own approximation of `normal`.
     */
    it("falls back to 1.2 times the font size when the line height is 'normal'", () => {
      const point = caretCoordinates(
        textarea("hello", { styles: { "line-height": "normal", "font-size": "20px" } })
      );

      expect(point.lineHeight).toBeCloseTo(24);
    });

    /**
     * The last fallback, reached two ways — both measured rather than assumed. A textarea that has
     * been unmounted while the suggestion list was still open computes to nothing at all, and a
     * font size of zero multiplies to a falsy zero. Either would otherwise place the list at
     * `NaN` or at the top of the page.
     */
    it("falls back to sixteen when the font size gives nothing either", () => {
      const unmounted = document.createElement("textarea");
      unmounted.value = "hello";

      expect(caretCoordinates(unmounted).lineHeight).toBe(16);
      expect(
        caretCoordinates(
          textarea("hello", { styles: { "line-height": "normal", "font-size": "0px" } })
        ).lineHeight
      ).toBe(16);
    });

    it("never answers NaN, whatever the field is styled with", () => {
      for (const lineHeight of ["normal", "inherit", "1.5", ""]) {
        const point = caretCoordinates(textarea("hello", { styles: { "line-height": lineHeight } }));

        expect(Number.isFinite(point.lineHeight), lineHeight).toBe(true);
        expect(point.lineHeight, lineHeight).toBeGreaterThan(0);
      }
    });
  });

  describe("the mirror it measures against", () => {
    /**
     * Read while the mirror is still attached, because it is removed before the function returns.
     * The style copy is what makes the measurement exact: a mirror that wraps differently from the
     * field puts the marker on the wrong line, which is the whole failure mode.
     */
    function mirrorDuring(element: HTMLTextAreaElement) {
      let seen: HTMLDivElement | null = null;
      const appendChild = document.body.appendChild.bind(document.body);
      const spy = (node: Node) => {
        if (node instanceof HTMLDivElement) seen = node;
        return appendChild(node);
      };
      document.body.appendChild = spy as typeof document.body.appendChild;
      try {
        caretCoordinates(element);
      } finally {
        document.body.appendChild = appendChild;
      }
      return seen as unknown as HTMLDivElement;
    }

    /**
     * Every property that decides where a line breaks, not a sample of three. The box metrics
     * matter as much as the typography — a mirror at a different width wraps at a different
     * column, which puts the marker on the wrong line, and that is the whole failure mode.
     */
    it.each([
      ["width", "width", "233px"],
      ["box-sizing", "boxSizing", "border-box"],
      ["padding-left", "paddingLeft", "13px"],
      ["padding-top", "paddingTop", "11px"],
      ["border-left-width", "borderLeftWidth", "3px"],
      ["font-size", "fontSize", "17px"],
      ["font-family", "fontFamily", "Georgia"],
      ["font-weight", "fontWeight", "700"],
      ["letter-spacing", "letterSpacing", "2px"],
      ["word-spacing", "wordSpacing", "4px"],
      ["line-height", "lineHeight", "29px"],
      ["text-indent", "textIndent", "7px"],
      ["text-transform", "textTransform", "uppercase"],
      ["word-break", "wordBreak", "break-all"],
    ])("copies %s onto the mirror", (property, camel, value) => {
      const mirror = mirrorDuring(textarea("hello", { styles: { [property]: value } }));

      expect((mirror.style as unknown as Record<string, string>)[camel]).toBe(value);
    });

    // It grows instead of scrolling, and wraps like the field does, so the marker lands on the
    // line the caret is really on rather than on the first line of an overflowing box.
    it("wraps and grows rather than scrolling", () => {
      const mirror = mirrorDuring(textarea("hello"));

      expect(mirror.style.whiteSpace).toBe("pre-wrap");
      expect(mirror.style.overflowWrap).toBe("break-word");
      expect(mirror.style.height).toBe("auto");
    });

    it("is positioned off-screen and hidden, so it is never seen", () => {
      const mirror = mirrorDuring(textarea("hello"));

      expect(mirror.style.position).toBe("absolute");
      expect(mirror.style.visibility).toBe("hidden");
      expect(mirror.style.left).toBe("-9999px");
    });

    it("splits the text at the caret, with the tail inside the marker", () => {
      const mirror = mirrorDuring(textarea("hello world", { caret: 5 }));

      expect(mirror.firstChild?.textContent).toBe("hello");
      expect(mirror.querySelector("span")?.textContent).toBe(" world");
    });

    /**
     * A marker with no content has no position of its own, so a caret at the very end of the text
     * — which is where it is most of the time — would measure as zero. The stop is filler, and it
     * is never rendered anywhere.
     */
    it("gives the marker a character to stand on when the caret is at the end", () => {
      const mirror = mirrorDuring(textarea("hello"));

      expect(mirror.querySelector("span")?.textContent).toBe(".");
    });

    // An unfocused textarea can report a null selection, and measuring from the end is the same
    // answer as measuring from where the caret will be when it is focused.
    it("measures from the end when the field reports no selection", () => {
      const element = textarea("hello");
      Object.defineProperty(element, "selectionStart", { value: null });

      const mirror = mirrorDuring(element);

      expect(mirror.firstChild?.textContent).toBe("hello");
      expect(mirror.querySelector("span")?.textContent).toBe(".");
    });
  });
});
