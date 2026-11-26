import {
  type BufferGeometry,
  CanvasTexture,
  Color,
  InstancedMesh,
  type Material,
  Matrix4,
  MeshStandardMaterial,
  type MeshStandardMaterialParameters,
  type Object3D,
  SRGBColorSpace,
  Vector3,
} from "three";
import type { Rgb } from "@/lib/oklch";

/**
 * Small Three.js helpers for Floor mode (#420): a kit that remembers every geometry, material
 * and texture it made so a rebuild or unmount frees them all, colours from sRGB triples, and
 * instanced meshes from lists of matrices (repeated furniture and crew parts are one draw call
 * each, however many there are).
 */

interface Disposable {
  dispose(): void;
}

export class Kit {
  private readonly owned = new Set<Disposable>();

  /** Keeps `thing` to dispose of later, and returns it. */
  own<T extends Disposable>(thing: T): T {
    this.owned.add(thing);
    return thing;
  }

  /** A matte material in this colour (white when it takes per-instance colours). */
  matte(rgb: Rgb | null, params: MeshStandardMaterialParameters = {}): MeshStandardMaterial {
    const m = new MeshStandardMaterial({ roughness: 0.75, metalness: 0, ...params });
    if (rgb) m.color = colour(rgb);
    return this.own(m);
  }

  /** A texture from a canvas, in sRGB. */
  canvasTexture(canvas: HTMLCanvasElement): CanvasTexture {
    const t = this.own(new CanvasTexture(canvas));
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }

  /**
   * One mesh drawing `geometry` at every matrix, with a colour each when given. Empty lists give
   * null, so nothing is drawn.
   */
  instanced(
    geometry: BufferGeometry,
    material: Material,
    matrices: readonly Matrix4[],
    colours?: readonly Rgb[],
    shadows: { cast?: boolean; receive?: boolean } = { cast: true, receive: true },
  ): InstancedMesh | null {
    if (matrices.length === 0) return null;
    const mesh = this.own(new InstancedMesh(geometry, material, matrices.length));
    matrices.forEach((m, i) => {
      mesh.setMatrixAt(i, m);
    });
    if (colours) {
      const c = new Color();
      colours.forEach((rgb, i) => {
        mesh.setColorAt(i, setColour(c, rgb));
      });
    }
    mesh.castShadow = shadows.cast ?? false;
    mesh.receiveShadow = shadows.receive ?? false;
    mesh.computeBoundingSphere();
    return mesh;
  }

  /** Frees everything the kit made. */
  dispose(): void {
    for (const thing of this.owned) thing.dispose();
    this.owned.clear();
  }
}

/**
 * An instanced mesh refilled every frame (#476): `begin`, a `push` per instance, `end`. It grows
 * by doubling when a frame needs more instances than it holds, and draws nothing while empty.
 * Instances move, so it is never frustum-culled on a stale bounding sphere.
 */
export class Pool {
  private mesh: InstancedMesh | null = null;
  private n = 0;
  private readonly c = new Color();

  constructor(
    private readonly parent: Object3D,
    private readonly geometry: BufferGeometry,
    private readonly material: Material,
    private readonly opts: { colours?: boolean; cast?: boolean; order?: number } = {},
  ) {}

  begin(): void {
    this.n = 0;
  }

  push(m: Matrix4, rgb?: Rgb): void {
    const mesh = this.room(this.n + 1);
    mesh.setMatrixAt(this.n, m);
    if (this.opts.colours)
      mesh.setColorAt(this.n, rgb ? setColour(this.c, rgb) : this.c.set(1, 1, 1));
    this.n += 1;
  }

  end(): void {
    const mesh = this.mesh;
    if (!mesh) return;
    mesh.count = this.n;
    mesh.visible = this.n > 0;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  /** The mesh, with room for at least `need` instances. */
  private room(need: number): InstancedMesh {
    if (this.mesh && this.mesh.instanceMatrix.count >= need) return this.mesh;
    const old = this.mesh;
    const cap = Math.max(8, need * 2, (old?.instanceMatrix.count ?? 0) * 2);
    const mesh = new InstancedMesh(this.geometry, this.material, cap);
    mesh.frustumCulled = false;
    mesh.castShadow = this.opts.cast ?? false;
    mesh.receiveShadow = false;
    if (this.opts.order !== undefined) mesh.renderOrder = this.opts.order;
    if (this.opts.colours) mesh.setColorAt(0, this.c.set(1, 1, 1));
    if (old) {
      mesh.instanceMatrix.array.set(old.instanceMatrix.array);
      if (old.instanceColor && mesh.instanceColor)
        mesh.instanceColor.array.set(old.instanceColor.array);
      this.parent.remove(old);
      old.dispose();
    }
    this.parent.add(mesh);
    this.mesh = mesh;
    return mesh;
  }

  dispose(): void {
    if (!this.mesh) return;
    this.parent.remove(this.mesh);
    this.mesh.dispose();
    this.mesh = null;
  }
}

/** Frees what `kit` made and takes `group`'s children off the scene. */
export function clear(group: Object3D, kit: Kit): void {
  group.clear();
  kit.dispose();
}

/** A Three.js colour from a gamma-encoded sRGB triple. */
export function colour(rgb: Rgb): Color {
  return setColour(new Color(), rgb);
}

export function setColour(c: Color, [r, g, b]: Rgb): Color {
  return c.setRGB(r, g, b, SRGBColorSpace);
}

/** A translation, with an optional turn around y and a scale. */
export function at(
  x: number,
  y: number,
  z: number,
  turnY = 0,
  scale?: [number, number, number],
): Matrix4 {
  const m = new Matrix4().makeRotationY(turnY);
  if (scale) m.scale(new Vector3(...scale));
  m.setPosition(x, y, z);
  return m;
}

/** A canvas of this size, for drawing a texture on. */
export function canvasOf(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  return canvas;
}
