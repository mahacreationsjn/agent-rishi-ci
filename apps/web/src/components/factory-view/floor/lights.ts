import {
  type Color,
  DirectionalLight,
  HemisphereLight,
  type Material,
  Mesh,
  type Object3D,
  Vector3,
} from "three";
import type { Box3D } from "./camera";
import { colour } from "./kit";
import type { FloorPalette } from "./palette";

/**
 * Floor mode's light (#420, #476): a hemisphere light and a sun from the upper left front with
 * soft shadows, its shadow camera fitted around everything that stands; dimmed to 40% while the
 * factory is stopped. And a storey's own dimming while the other one is focused.
 */

const SHADOW_MAP = 1024;
/** Toward the sun: from the upper left front, as the camera sees the hall. */
const SUN = new Vector3(-0.2, 1.5, 1).normalize();
/** The hall's lights while the factory is stopped. */
export const STOPPED_LIGHT = 0.4;

export class Lights {
  readonly hemi = new HemisphereLight(0xffffff, 0xffffff, 1);
  readonly sun = new DirectionalLight(0xffffff, 1);

  constructor() {
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    this.sun.shadow.radius = 4;
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.02;
  }

  /** Lights `boxes` in `p`'s colours, dimmed when the factory is stopped. */
  set(boxes: readonly Box3D[], p: FloorPalette, stopped: boolean): void {
    const dim = stopped ? STOPPED_LIGHT : 1;
    this.hemi.color = colour(p.sky);
    this.hemi.groundColor = colour(p.floor);
    this.hemi.intensity = p.light.hemi * dim;
    this.sun.color = colour(p.sky);
    this.sun.intensity = p.light.sun * dim;
    if (boxes.length === 0) return;
    // Aim the sun at the middle of everything and fit its shadow camera around it.
    const x0 = Math.min(...boxes.map((b) => b.x0));
    const x1 = Math.max(...boxes.map((b) => b.x1));
    const z0 = Math.min(...boxes.map((b) => b.z0));
    const z1 = Math.max(...boxes.map((b) => b.z1));
    const centre = new Vector3((x0 + x1) / 2, 0, (z0 + z1) / 2);
    this.sun.position.copy(centre).addScaledVector(SUN, 60);
    this.sun.target.position.copy(centre);
    this.sun.updateMatrixWorld();
    this.sun.target.updateMatrixWorld();
    const cam = this.sun.shadow.camera;
    cam.position.copy(this.sun.position);
    cam.lookAt(centre);
    cam.updateMatrixWorld();
    const view = cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    const box = {
      minX: Infinity,
      maxX: -Infinity,
      minY: Infinity,
      maxY: -Infinity,
      minZ: Infinity,
      maxZ: -Infinity,
    };
    const v = new Vector3();
    for (const b of boxes)
      for (const x of [b.x0 - 0.2, b.x1 + 0.2])
        for (const y of [b.y0, b.y1 + 0.3])
          for (const z of [b.z0 - 0.2, b.z1 + 0.2]) {
            v.set(x, y, z).applyMatrix4(view);
            box.minX = Math.min(box.minX, v.x);
            box.maxX = Math.max(box.maxX, v.x);
            box.minY = Math.min(box.minY, v.y);
            box.maxY = Math.max(box.maxY, v.y);
            box.minZ = Math.min(box.minZ, v.z);
            box.maxZ = Math.max(box.maxZ, v.z);
          }
    cam.left = box.minX;
    cam.right = box.maxX;
    cam.bottom = box.minY;
    cam.top = box.maxY;
    cam.near = Math.max(0.1, -box.maxZ - 1);
    cam.far = -box.minZ + 1;
    cam.updateProjectionMatrix();
    this.sun.shadow.needsUpdate = true;
  }

  dispose(): void {
    this.sun.shadow.map?.dispose();
    this.sun.dispose();
    this.hemi.dispose();
  }
}

interface Lit {
  color?: Color;
  emissiveIntensity?: number;
}

/**
 * Dims everything under `root` to `light` (1 is as built): every material's colour and glow is
 * scaled from what it was built with.
 */
export function dimTree(root: Object3D, light: number): void {
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const materials: Material[] = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of materials) {
      const lit = m as Material & Lit;
      if (!m.userData.base)
        m.userData.base = { color: lit.color?.clone(), glow: lit.emissiveIntensity };
      const base = m.userData.base as { color?: Color; glow?: number };
      if (base.color && lit.color) lit.color.copy(base.color).multiplyScalar(light);
      if (base.glow !== undefined) lit.emissiveIntensity = base.glow * light;
    }
  });
}
