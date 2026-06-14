import {
  BufferGeometry,
  Color,
  Group,
  InstancedMesh,
  Material,
  Matrix4,
  Raycaster,
  Scene,
  type Intersection,
} from "three";

export type InstancedMeshBatchOptions<TGeometry extends BufferGeometry, TMaterial extends Material> = {
  scene: Scene;
  geometry: TGeometry;
  material: TMaterial;
  chunkCapacity?: number;
  frustumCulled?: boolean;
  name?: string;
  renderOrder?: number;
};

type BatchChunk<TGeometry extends BufferGeometry, TMaterial extends Material, TMetadata> = {
  mesh: InstancedMesh<TGeometry, TMaterial>;
  metadata: TMetadata[];
};

const DEFAULT_CHUNK_CAPACITY = 1000;

export class InstancedMeshBatch<TGeometry extends BufferGeometry, TMaterial extends Material, TMetadata = never> {
  readonly root = new Group();
  readonly geometry: TGeometry;
  readonly material: TMaterial;
  readonly chunkCapacity: number;

  private readonly chunks: BatchChunk<TGeometry, TMaterial, TMetadata>[] = [];
  private readonly scene: Scene;
  private readonly frustumCulled: boolean;
  private readonly renderOrder: number;
  private writeCount = 0;

  constructor(options: InstancedMeshBatchOptions<TGeometry, TMaterial>) {
    this.scene = options.scene;
    this.geometry = options.geometry;
    this.material = options.material;
    this.chunkCapacity = options.chunkCapacity ?? DEFAULT_CHUNK_CAPACITY;
    this.frustumCulled = options.frustumCulled ?? false;
    this.renderOrder = options.renderOrder ?? 0;
    this.root.name = options.name ?? "instanced-mesh-batch";
    this.scene.add(this.root);
  }

  get count(): number {
    return this.writeCount;
  }

  get meshes(): InstancedMesh<TGeometry, TMaterial>[] {
    return this.chunks.map((chunk) => chunk.mesh);
  }

  begin(): void {
    this.writeCount = 0;
  }

  pushMatrix(matrix: Matrix4, metadata?: TMetadata, color?: Color): number {
    const globalIndex = this.writeCount;
    const chunkIndex = Math.floor(globalIndex / this.chunkCapacity);
    const instanceIndex = globalIndex - chunkIndex * this.chunkCapacity;
    const chunk = this.ensureChunk(chunkIndex);

    chunk.mesh.setMatrixAt(instanceIndex, matrix);
    if (color) {
      chunk.mesh.setColorAt(instanceIndex, color);
    }
    if (metadata !== undefined) {
      chunk.metadata[instanceIndex] = metadata;
    }

    this.writeCount += 1;
    return globalIndex;
  }

  finish(): void {
    for (let chunkIndex = 0; chunkIndex < this.chunks.length; chunkIndex += 1) {
      const chunk = this.chunks[chunkIndex];
      const chunkStart = chunkIndex * this.chunkCapacity;
      const visibleCount = Math.max(0, Math.min(this.chunkCapacity, this.writeCount - chunkStart));
      chunk.mesh.count = visibleCount;
      chunk.mesh.instanceMatrix.needsUpdate = true;
      if (chunk.mesh.instanceColor) {
        chunk.mesh.instanceColor.needsUpdate = true;
      }
      if (visibleCount > 0) {
        chunk.mesh.computeBoundingSphere();
      }
    }
  }

  clear(): void {
    this.writeCount = 0;
    this.finish();
  }

  pick(raycaster: Raycaster): { metadata: TMetadata; distance: number; intersection: Intersection } | null {
    let best: { metadata: TMetadata; distance: number; intersection: Intersection } | null = null;

    for (const chunk of this.chunks) {
      if (chunk.mesh.count === 0) {
        continue;
      }

      const hit = raycaster.intersectObject(chunk.mesh, false)[0];
      if (!hit || hit.instanceId === undefined) {
        continue;
      }

      const metadata = chunk.metadata[hit.instanceId];
      if (metadata === undefined || (best && hit.distance >= best.distance)) {
        continue;
      }

      best = { metadata, distance: hit.distance, intersection: hit };
    }

    return best;
  }

  dispose(): void {
    this.scene.remove(this.root);
    this.root.clear();
    this.chunks.length = 0;
    this.writeCount = 0;
  }

  private ensureChunk(chunkIndex: number): BatchChunk<TGeometry, TMaterial, TMetadata> {
    let chunk = this.chunks[chunkIndex];
    if (chunk) {
      return chunk;
    }

    const mesh = new InstancedMesh(this.geometry, this.material, this.chunkCapacity);
    mesh.frustumCulled = this.frustumCulled;
    mesh.renderOrder = this.renderOrder;
    mesh.count = 0;
    this.root.add(mesh);
    chunk = { mesh, metadata: [] };
    this.chunks[chunkIndex] = chunk;
    return chunk;
  }
}
