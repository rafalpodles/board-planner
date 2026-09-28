import { describe, it, expect } from "vitest";
import type { ClientRect, CollisionDetection, DroppableContainer } from "@dnd-kit/core";
import { collisionDetection } from "./drag";

type Args = Parameters<CollisionDetection>[0];

function rect(top: number, height: number, left = 0, width = 600): ClientRect {
  return { top, height, left, width, bottom: top + height, right: left + width };
}

function container(id: string, bucket?: string): DroppableContainer {
  return {
    id,
    key: id,
    disabled: false,
    node: { current: null },
    rect: { current: null },
    data: { current: bucket ? { sortable: { containerId: bucket, index: 0, items: [] } } : {} },
  } as unknown as DroppableContainer;
}

// Delivery spans 100..300 with 8px of padding; its three cards are 50px tall with 8px between.
const layout: [DroppableContainer, ClientRect][] = [
  [container("bucket:delivery"), rect(100, 200)],
  [container("push", "bucket:delivery"), rect(108, 50)],
  [container("pull-request", "bucket:delivery"), rect(166, 50)],
  [container("merge", "bucket:delivery"), rect(224, 50)],
  [container("bucket:verification"), rect(400, 100)],
  [container("build", "bucket:verification"), rect(408, 50)],
  [container("bucket:analysis"), rect(600, 72)],
];

function detect(pointer: { x: number; y: number } | null, collisionRect = rect(0, 10)) {
  const args: Args = {
    active: { id: "dragged" } as Args["active"],
    collisionRect,
    droppableRects: new Map(layout.map(([c, r]) => [c.id, r])),
    droppableContainers: layout.map(([c]) => c),
    pointerCoordinates: pointer,
  };
  return collisionDetection(args).map((hit) => hit.id);
}

describe("where a drag lands", () => {
  it("is the card under the pointer", () => {
    expect(detect({ x: 300, y: 190 })[0]).toBe("pull-request");
  });

  it("is the nearest card when the pointer is in the gap between two", () => {
    expect(detect({ x: 300, y: 222 })[0]).toBe("merge");
    expect(detect({ x: 300, y: 217 })[0]).toBe("pull-request");
  });

  it("is the first card when the pointer is in the padding above it", () => {
    expect(detect({ x: 300, y: 103 })[0]).toBe("push");
  });

  // Appending is what the phase alone means, and below the last card is where that is meant
  it("is the phase itself below its last card", () => {
    expect(detect({ x: 300, y: 290 })).toEqual(["bucket:delivery"]);
  });

  it("is the phase itself when it holds nothing", () => {
    expect(detect({ x: 300, y: 630 })).toEqual(["bucket:analysis"]);
  });

  it("never picks a card from a phase the pointer is not in", () => {
    expect(detect({ x: 300, y: 403 })[0]).toBe("build");
  });

  it("falls back to the dragged rectangle when there is no pointer, as from the keyboard", () => {
    expect(detect(null, rect(410, 30))).toContain("build");
  });

  it("is nothing when the pointer and the dragged rectangle are over nothing", () => {
    expect(detect({ x: 300, y: 1_000 }, rect(1_000, 10))).toEqual([]);
  });
});
