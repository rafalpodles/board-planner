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
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.style.height = "auto";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";

  const caret = textarea.selectionStart ?? textarea.value.length;
  mirror.textContent = textarea.value.slice(0, caret);

  const marker = document.createElement("span");
  marker.textContent = textarea.value.slice(caret) || ".";
  mirror.appendChild(marker);

  document.body.appendChild(mirror);
  const lineHeight = parseInt(style.lineHeight, 10) || parseInt(style.fontSize, 10) * 1.2 || 16;
  const point = {
    top: marker.offsetTop - textarea.scrollTop,
    left: marker.offsetLeft - textarea.scrollLeft,
    lineHeight,
  };
  document.body.removeChild(mirror);

  return point;
}
