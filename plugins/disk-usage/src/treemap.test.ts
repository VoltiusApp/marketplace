import { expect, test } from "vitest";
import { squarify } from "./treemap";

test("tiles fill the bounds in proportion to their weight", () => {
  const items = [6, 6, 4, 3, 2, 2, 1].map((weight, i) => ({ item: i, weight }));
  const tiles = squarify(items, { x: 0, y: 0, w: 600, h: 400 });
  expect(tiles).toHaveLength(7);
  const total = tiles.reduce((a, t) => a + t.w * t.h, 0);
  expect(total).toBeCloseTo(600 * 400, 3);
  tiles.forEach((t) => {
    expect((t.w * t.h) / (600 * 400)).toBeCloseTo(items[t.item].weight / 24, 5);
    expect(t.x).toBeGreaterThanOrEqual(-1e-9);
    expect(t.y + t.h).toBeLessThanOrEqual(400 + 1e-9);
  });
});

test("zero weights and empty bounds give no tiles", () => {
  expect(squarify([{ item: 0, weight: 0 }], { x: 0, y: 0, w: 10, h: 10 })).toEqual([]);
  expect(squarify([{ item: 0, weight: 3 }], { x: 0, y: 0, w: 0, h: 10 })).toEqual([]);
});
