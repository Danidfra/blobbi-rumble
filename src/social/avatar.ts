/**
 * A DETERMINISTIC FALLBACK AVATAR from a pubkey: a hue and a mirrored 5×5
 * pattern (an identicon), so someone without a picture (or whose picture
 * fails) still looks like someone, the same everywhere. Data only; drawing
 * it is the caller's. Framework-free; no Rumble imports.
 */
export interface FallbackAvatar {
  /** 0..359 */
  hue: number;
  /** 25 cells, row by row, mirrored left-right. */
  cells: boolean[];
}

export function fallbackAvatar(pubkey: string): FallbackAvatar {
  const byte = (i: number) => parseInt(pubkey.slice(i * 2, i * 2 + 2), 16) || 0;
  const hue = ((byte(0) << 8) | byte(1)) % 360;
  const cells: boolean[] = [];
  for (let row = 0; row < 5; row++) {
    const half = [0, 1, 2].map((col) => (byte(2 + row * 3 + col) & 1) === 1);
    cells.push(half[0], half[1], half[2], half[1], half[0]);
  }
  // Never a blank face.
  if (!cells.some(Boolean)) cells[12] = true;
  return { hue, cells };
}
