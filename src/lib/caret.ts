// Where the caret is, in pixels relative to the textarea's own box.
//
// A textarea gives no way to ask. The standard answer is to build a hidden element with the same
// text and the same typography, put a marker where the caret is, and measure that — which is exact
// as long as every property that affects wrapping is copied across.
//
// Needed because a suggestion list pinned to the edge of its field reads fine on a two-line comment
// box and absurdly on a 400px description: the list appeared at the top of the screen while the
// person was typing at the bottom.
const COPIED = [
  "boxSizing",
  "width",
  "borderLeftWidth",
  "borderRightWidth",
  "borderTopWidth",
  "borderBottomWidth",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontStretch",
  "fontSize",
  "fontFamily",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "textTransform",
  "textIndent",
  "textAlign",
  "whiteSpace",
  "wordBreak",
  "overflowWrap",
  "tabSize",
] as const;

export interface CaretPoint {
  top: number;
  left: number;
  /** The line's height, so a caller can place something below the line rather than over it. */
  lineHeight: number;
}

export function caretCoordinates(textarea: HTMLTextAreaElement): CaretPoint {
  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");

  for (const property of COPIED) {
    mirror.style[property] = style[property];
  }
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  // The mirror wraps like the textarea does, and grows instead of scrolling, so the marker lands
  // on the line the caret is really on
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.style.height = "auto";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";

  const caret = textarea.selectionStart ?? textarea.value.length;
  mirror.textContent = textarea.value.slice(0, caret);

  // A marker with content, because an empty inline element has no position of its own
  const marker = document.createElement("span");
  marker.textContent = textarea.value.slice(caret) || ".";
  mirror.appendChild(marker);

  document.body.appendChild(mirror);
  const lineHeight = parseInt(style.lineHeight, 10) || parseInt(style.fontSize, 10) * 1.2 || 16;
  const point = {
    // Minus the scroll: the caret can be on a line the field has scrolled past
    top: marker.offsetTop - textarea.scrollTop,
    left: marker.offsetLeft - textarea.scrollLeft,
    lineHeight,
  };
  document.body.removeChild(mirror);

  return point;
}
