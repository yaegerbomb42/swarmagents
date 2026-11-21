export interface DamageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DiffResult {
  changed: boolean;
  changedRatio: number;
  regions: DamageRegion[];
}

export function computeDamageRegions(
  prev: Uint8Array | null,
  next: Uint8Array,
  width: number,
  height: number,
  tileSize = 32,
  channelDeltaThreshold = 10,
  minChangedRatio = 0.0005,
): DiffResult {
  if (prev?.byteLength !== next.byteLength) {
    return {
      changed: true,
      changedRatio: 1,
      regions: [{ x: 0, y: 0, width, height }],
    };
  }

  const regions: DamageRegion[] = [];
  let changedTiles = 0;
  const cols = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);
  const totalTiles = cols * rows;

  for (let ty = 0; ty < rows; ty++) {
    const yStart = ty * tileSize;
    const yEnd = Math.min(height, yStart + tileSize);
    for (let tx = 0; tx < cols; tx++) {
      const xStart = tx * tileSize;
      const xEnd = Math.min(width, xStart + tileSize);
      if (isTileDirty(prev, next, width, xStart, xEnd, yStart, yEnd, channelDeltaThreshold)) {
        changedTiles++;
        regions.push({
          x: xStart,
          y: yStart,
          width: xEnd - xStart,
          height: yEnd - yStart,
        });
      }
    }
  }

  const changedRatio = totalTiles > 0 ? changedTiles / totalTiles : 0;
  return {
    changed: changedRatio >= minChangedRatio,
    changedRatio,
    regions,
  };
}

/** True when any sampled pixel in the tile moved past the channel threshold. */
function isTileDirty(
  prev: Uint8Array,
  next: Uint8Array,
  width: number,
  xStart: number,
  xEnd: number,
  yStart: number,
  yEnd: number,
  channelDeltaThreshold: number,
): boolean {
  // Sample every 2nd pixel inside the tile for fast CPU diffing.
  for (let y = yStart; y < yEnd; y += 2) {
    for (let x = xStart; x < xEnd; x += 2) {
      const idx = (y * width + x) * 4;
      const dr = Math.abs((next[idx] ?? 0) - (prev[idx] ?? 0));
      const dg = Math.abs((next[idx + 1] ?? 0) - (prev[idx + 1] ?? 0));
      const db = Math.abs((next[idx + 2] ?? 0) - (prev[idx + 2] ?? 0));
      if (dr > channelDeltaThreshold || dg > channelDeltaThreshold || db > channelDeltaThreshold) {
        return true;
      }
    }
  }
  return false;
}
