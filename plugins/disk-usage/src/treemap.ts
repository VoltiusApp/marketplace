export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Tile<T> extends Rect {
  item: T;
}

function worst(row: number[], side: number): number {
  const sum = row.reduce((a, b) => a + b, 0);
  const max = Math.max(...row);
  const min = Math.min(...row);
  return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
}

/** Squarified treemap (Bruls et al.); `items` must be sorted by weight, largest first. */
export function squarify<T>(items: { item: T; weight: number }[], bounds: Rect): Tile<T>[] {
  const total = items.reduce((a, i) => a + i.weight, 0);
  const positive = items.filter((i) => i.weight > 0);
  if (total <= 0 || bounds.w <= 0 || bounds.h <= 0) return [];
  const scale = (bounds.w * bounds.h) / total;
  const areas = positive.map((i) => i.weight * scale);
  const tiles: Tile<T>[] = [];
  let free = { ...bounds };
  let start = 0;
  while (start < areas.length) {
    const side = Math.min(free.w, free.h);
    let end = start + 1;
    while (end < areas.length && worst(areas.slice(start, end + 1), side) <= worst(areas.slice(start, end), side)) {
      end += 1;
    }
    const row = areas.slice(start, end);
    const rowArea = row.reduce((a, b) => a + b, 0);
    const horizontal = free.w >= free.h;
    const thickness = rowArea / (horizontal ? free.h : free.w);
    let offset = 0;
    row.forEach((area, k) => {
      const length = area / thickness;
      tiles.push(
        horizontal
          ? { item: positive[start + k].item, x: free.x, y: free.y + offset, w: thickness, h: length }
          : { item: positive[start + k].item, x: free.x + offset, y: free.y, w: length, h: thickness },
      );
      offset += length;
    });
    free = horizontal
      ? { x: free.x + thickness, y: free.y, w: free.w - thickness, h: free.h }
      : { x: free.x, y: free.y + thickness, w: free.w, h: free.h - thickness };
    start = end;
  }
  return tiles;
}
