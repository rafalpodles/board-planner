import {
  AutoScrollOptions,
  ClientRect,
  Collision,
  CollisionDetection,
  closestCenter,
  pointerWithin,
  rectIntersection,
} from "@dnd-kit/core";
import { BUCKET_PREFIX } from "./components/blocks";

// No horizontal scrolling, and a 5% band instead of dnd-kit's 20%, which covered Delivery's cards (BP-745)
export const AUTO_SCROLL: AutoScrollOptions = { threshold: { x: 0, y: 0.05 } };

const isBucket = (id: string | number) => String(id).startsWith(BUCKET_PREFIX);

function pointAt({ x, y }: { x: number; y: number }): ClientRect {
  return { top: y, bottom: y, left: x, right: x, width: 0, height: 0 };
}

/** Whether the pointer was below the middle of the card it landed on, so an insert goes after it. */
export function landsAfter(collision: Collision | null | undefined): boolean {
  return collision?.data?.after === true;
}

// In a gap between cards, the nearest card of the bucket under the pointer rather than the bucket
export const collisionDetection: CollisionDetection = (args) => {
  const byPointer = pointerWithin(args);
  if (byPointer.length === 0) return rectIntersection(args);

  const bucket = byPointer.find((hit) => isBucket(hit.id));
  const pointer = args.pointerCoordinates;
  if (!bucket || !pointer) return byPointer;

  const cards = args.droppableContainers.filter(
    (container) => container.data.current?.sortable?.containerId === bucket.id
  );
  const onCard = byPointer.find((hit) => !isBucket(hit.id));
  const lowest = Math.max(...cards.map((card) => args.droppableRects.get(card.id)?.bottom ?? -Infinity));
  if (!onCard && pointer.y > lowest) return [bucket];

  const [nearest] = onCard
    ? [onCard]
    : closestCenter({ ...args, collisionRect: pointAt(pointer), droppableContainers: cards });
  const rect = args.droppableRects.get(nearest.id);
  const after = !!rect && pointer.y > rect.top + rect.height / 2;
  return [{ ...nearest, data: { ...nearest.data, after } }];
};
