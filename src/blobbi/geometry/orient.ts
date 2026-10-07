import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';

/**
 * The rotation that points a node's local +Z along `forward` with its local
 * +Y as upright as possible. Built from an explicit basis (rather than
 * `FromLookDirectionLH`, whose result is the view rotation, the inverse of
 * this) so there is no doubt which way a part faces.
 */
export function rotationFacing(forward: Vector3, up: Vector3 = Vector3.Up()): Quaternion {
  const z = forward.normalizeToNew();
  let x = Vector3.Cross(up, z);
  if (x.lengthSquared() < 1e-8) x = Vector3.Cross(new Vector3(0, 0, 1), z);
  x.normalize();
  const y = Vector3.Cross(z, x).normalize();
  return Quaternion.RotationQuaternionFromAxis(x, y, z);
}
