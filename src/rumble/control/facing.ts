/**
 * FACING: the direction a fighter faces turns toward its horizontal
 * velocity once it is really moving. Gameplay, not looks: a punch and a
 * grab are aimed along the facing. Pure.
 */
export function facingYaw(vx: number, vz: number, current: number, dt: number, turnRate = 12): number {
  if (Math.hypot(vx, vz) < 0.15) return current;
  const target = Math.atan2(vx, vz);
  let d = target - current;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return current + d * (1 - Math.exp(-dt * turnRate));
}
