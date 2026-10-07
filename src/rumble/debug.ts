/**
 * DEBUG: a toggle (F3) that shows the gameplay colliders over the visual
 * Blobbis through Babylon's PhysicsViewer, and a HUD that prints what the
 * physics knows. Off by default.
 */
import { PhysicsViewer } from '@babylonjs/core/Debug/physicsViewer';
import type { PhysicsBody } from '@babylonjs/core/Physics/v2/physicsBody';
import type { Scene } from '@babylonjs/core/scene';

export class PhysicsDebug {
  private viewer: PhysicsViewer | null = null;
  private bodies: PhysicsBody[] = [];
  on = false;

  constructor(private scene: Scene, private hud: HTMLElement) {}

  track(body: PhysicsBody) {
    this.bodies.push(body);
    if (this.on) this.viewer?.showBody(body);
  }

  toggle() {
    this.on = !this.on;
    if (this.on) {
      this.viewer = new PhysicsViewer(this.scene);
      for (const body of this.bodies) this.viewer.showBody(body);
    } else {
      this.viewer?.dispose();
      this.viewer = null;
    }
  }

  print(lines: string[]) {
    this.hud.textContent = lines.join('\n');
  }
}
