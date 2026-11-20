/**
 * A squarified treemap.
 *
 * The codebase heatmap draws one rectangle per file, sized by its heat. A
 * squarified treemap (Bruls, Huizing & van Wijk) keeps the rectangles close
 * to square, so the map stays readable instead of turning into a few long
 * slivers.
 */

export interface TreemapEntry {
  path: string;
  value: number;
}

export interface TreemapRect {
  path: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Cell {
  path: string;
  area: number;
}

/** The worst aspect ratio of a row laid out along a side of `side` units. */
function worstRatio(cells: Cell[], side: number): number {
  let sum = 0;
  let max = 0;
  let min = Infinity;
  for (const cell of cells) {
    sum += cell.area;
    if (cell.area > max) max = cell.area;
    if (cell.area < min) min = cell.area;
  }
  if (sum <= 0 || min <= 0 || side <= 0) return Infinity;
  const sumSq = sum * sum;
  const sideSq = side * side;
  return Math.max((sideSq * max) / sumSq, sumSq / (sideSq * min));
}

/** Lay the cells out in the given box (any orientation). */
function layout(cells: Cell[], x: number, y: number, w: number, h: number, out: TreemapRect[]): void {
  if (cells.length === 0 || w <= 0 || h <= 0) return;
  if (cells.length === 1) {
    out.push({ path: cells[0].path, x, y, width: w, height: h });
    return;
  }

  // The row is a strip along the long side of the box; its thickness is the
  // row area divided by that side.
  const horizontal = w >= h;
  const long = horizontal ? w : h;

  // Grow a row while it keeps improving the aspect ratio.
  const row: Cell[] = [];
  let index = 0;
  while (index < cells.length) {
    const candidate = row.concat([cells[index]]);
    if (row.length === 0 || worstRatio(candidate, long) <= worstRatio(row, long)) {
      row.push(cells[index]);
      index += 1;
    } else break;
  }

  const rowArea = row.reduce((sum, cell) => sum + cell.area, 0);
  const rowThickness = rowArea / long;
  if (!Number.isFinite(rowThickness) || rowThickness <= 0) {
    // Degenerate row (zero area): give every cell an equal slice.
    const share = long / row.length;
    row.forEach((cell, i) => {
      if (horizontal) out.push({ path: cell.path, x: x + i * share, y, width: share, height: h });
      else out.push({ path: cell.path, x, y: y + i * share, width: w, height: share });
    });
    layout(cells.slice(index), x, y, w, h, out);
    return;
  }

  let offset = 0;
  for (const cell of row) {
    const cellLength = cell.area / rowThickness;
    if (horizontal) {
      out.push({ path: cell.path, x: x + offset, y, width: cellLength, height: rowThickness });
    } else {
      out.push({ path: cell.path, x, y: y + offset, width: rowThickness, height: cellLength });
    }
    offset += cellLength;
  }
  if (horizontal) layout(cells.slice(index), x, y + rowThickness, w, h - rowThickness, out);
  else layout(cells.slice(index), x + rowThickness, y, w - rowThickness, h, out);
}

/**
 * Lay the entries out as a treemap. Entries without a positive value are
 * dropped; the rest are sized by their share of the total.
 */
export function squarifiedTreemap(
  entries: TreemapEntry[],
  width: number,
  height: number,
): TreemapRect[] {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return [];
  const usable = entries
    .filter((entry) => Number.isFinite(entry.value) && entry.value > 0)
    .sort((a, b) => b.value - a.value || a.path.localeCompare(b.path));
  if (usable.length === 0) return [];
  const total = usable.reduce((sum, entry) => sum + entry.value, 0);
  if (total <= 0) return [];

  const cells: Cell[] = usable.map((entry) => ({
    path: entry.path,
    area: (entry.value / total) * width * height,
  }));

  const out: TreemapRect[] = [];
  layout(cells, 0, 0, width, height, out);
  return out;
}
