import {
  AutoScrollOptions,
  ClientRect,
  CollisionDetection,
  closestCenter,
  pointerWithin,
  rectIntersection,
} from "@dnd-kit/core";
import { BUCKET_PREFIX } from "./components/blocks";

// dnd-kit's default 20% band covered Delivery's cards: resting on one scrolled it out from under the
// pointer, and the drop landed on nothing (BP-745)
export const AUTO_SCROLL: AutoScrollOptions = { threshold: { x: 0, y: 0.05 } };

const isBucket = (id: string | number) => String(id).startsWith(BUCKET_PREFIX);

function pointAt({ x, y }: { x: number; y: number }): ClientRect {
  return { top: y, bottom: y, left: x, right: x, width: 0, height: 0 };
}

// The bucket under the pointer, then the card under it. In a gap between cards the nearest card:
// the bucket alone means "append", and sent a card dropped between two others to the end.
export const collisionDetection: CollisionDetection = (args) => {
  const byPointer = pointerWithin(args);
  if (byPointer.length === 0) return rectIntersection(args);

  const bucket = byPointer.find((hit) => isBucket(hit.id));
  const pointer = args.pointerCoordinates;
  if (!bucket || !pointer || byPointer.some((hit) => !isBucket(hit.id))) return byPointer;

  const cards = args.droppableContainers.filter(
    (container) => container.data.current?.sortable?.containerId === bucket.id
  );
  const lowest = Math.max(...cards.map((card) => args.droppableRects.get(card.id)?.bottom ?? -Infinity));
  if (cards.length === 0 || pointer.y > lowest) return [bucket];

  return closestCenter({ ...args, collisionRect: pointAt(pointer), droppableContainers: cards });
};
