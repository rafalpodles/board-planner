import { ImageResponse } from "next/og";
import { APP_DESCRIPTION, APP_NAME } from "@/lib/brand";

export const alt = APP_NAME;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const CARDS: { x: number; y: number; opacity: number }[] = [
  { x: 5, y: 6, opacity: 0.9 },
  { x: 5, y: 12, opacity: 0.6 },
  { x: 13, y: 6, opacity: 0.9 },
  { x: 13, y: 12, opacity: 0.6 },
  { x: 13, y: 18, opacity: 0.4 },
  { x: 21, y: 6, opacity: 0.9 },
];
const UNIT = 10;

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#3b82f6",
          color: "white",
        }}
      >
        <div style={{ position: "relative", display: "flex", width: 22 * UNIT, height: 16 * UNIT }}>
          {CARDS.map((card) => (
            <div
              key={`${card.x}-${card.y}`}
              style={{
                position: "absolute",
                left: (card.x - 5) * UNIT,
                top: (card.y - 6) * UNIT,
                width: 6 * UNIT,
                height: 4 * UNIT,
                borderRadius: UNIT,
                background: "white",
                opacity: card.opacity,
              }}
            />
          ))}
        </div>
        <div style={{ marginTop: 36, fontSize: 84, fontWeight: 700, letterSpacing: -2 }}>{APP_NAME}</div>
        <div style={{ marginTop: 12, fontSize: 32, opacity: 0.85 }}>{APP_DESCRIPTION}</div>
      </div>
    ),
    size
  );
}
