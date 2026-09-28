import { describe, it, expect } from "vitest";
import type { ClientRect, CollisionDetection, DroppableContainer } from "@dnd-kit/core";
import { collisionDetection, landsAfter } from "./drag";

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
  // A deep top padding, so the nearest card to its top edge is Delivery's last one
  [container("bucket:verification"), rect(310, 110)],
  [container("build", "bucket:verification"), rect(360, 50)],
  [container("bucket:analysis"), rect(600, 72)],
];

function collide(pointer: { x: number; y: number } | null, collisionRect = rect(0, 10)) {
  const args: Args = {
    active: { id: "dragged" } as Args["active"],
    collisionRect,
    droppableRects: new Map(layout.map(([c, r]) => [c.id, r])),
    droppableContainers: layout.map(([c]) => c),
    pointerCoordinates: pointer,
  };
  return collisionDetection(args);
}

const detect = (...args: Parameters<typeof collide>) => collide(...args).map((hit) => hit.id);

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

  it("takes the nearest card from the phase the pointer is in, never from its neighbour", () => {
    expect(detect({ x: 300, y: 315 })[0]).toBe("build");
  });

  it("falls back to the dragged rectangle when there is no pointer, as from the keyboard", () => {
    expect(detect(null, rect(365, 30))).toContain("build");
  });

  it("is nothing when the pointer and the dragged rectangle are over nothing", () => {
    expect(detect({ x: 300, y: 1_000 }, rect(1_000, 10))).toEqual([]);
  });
});

// A palette block has no position of its own to move from, so which side of the card it lands on
// is the pointer's to say
describe("which side of the card a drop lands", () => {
  it.each([
    ["the upper half of a card", 180, "pull-request", false],
    ["the lower half of a card", 205, "pull-request", true],
    ["the upper half of a gap, nearest the card above", 217, "pull-request", true],
    ["the lower half of a gap, nearest the card below", 222, "merge", false],
    ["the padding above the first card", 103, "push", false],
  ])("is decided by the pointer in %s", (_where, y, card, after) => {
    const [hit] = collide({ x: 300, y });

    expect(hit.id).toBe(card);
    expect(landsAfter(hit)).toBe(after);
  });

  it("is not claimed when there is no pointer", () => {
    expect(collide(null, rect(365, 30)).some(landsAfter)).toBe(false);
  });
});
