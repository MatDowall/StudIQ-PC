import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { MEMBER_COLOURS, type AreaMesh3D, type Member3D } from "../lib/framing3d";

/** Compose the member's yaw (about world-up) and pitch (about its local across-axis) into a quaternion. */
function quaternionFor(yaw: number, pitch: number): [number, number, number, number] {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  if (pitch) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), pitch));
  return [q.x, q.y, q.z, q.w];
}

/** Builds a hexahedron (rake/plumb-cut wedge): `quad` is a 4-point cross-section in the local
 *  X (along)/Y (height) plane, extruded `depthM` along local Z (across the wall). */
function wedgeGeometry(quad: [number, number][], depthM: number): THREE.BufferGeometry {
  const d = depthM / 2;
  const front = quad.map(([x, y]) => [x, y, -d]);
  const back = quad.map(([x, y]) => [x, y, d]);
  const tri = (a: number[], b: number[], c: number[]) => [...a, ...b, ...c];
  const face = (a: number[], b: number[], c: number[], dd: number[]) => [...tri(a, b, c), ...tri(a, c, dd)];
  const positions = new Float32Array([
    ...face(front[0], front[1], front[2], front[3]), // front
    ...face(back[3], back[2], back[1], back[0]), // back
    ...face(front[0], front[1], back[1], back[0]), // bottom
    ...face(front[3], front[2], back[2], back[3]), // top
    ...face(front[3], front[0], back[0], back[3]), // start end
    ...face(front[1], front[2], back[2], back[1]), // finish end
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function WedgeMesh({ mem }: { mem: Member3D }) {
  const geometry = useMemo(() => wedgeGeometry(mem.wedge!.quad, mem.wedge!.depthM), [mem.wedge]);
  return (
    <mesh position={mem.position} rotation={[0, mem.yaw, 0]} geometry={geometry}>
      <meshLambertMaterial color={mem.color ?? MEMBER_COLOURS[mem.kind] ?? "#999999"} side={THREE.DoubleSide} />
    </mesh>
  );
}

/** Builds a polygon footprint (world X/Z, `points`) extruded up from `baseY` by `heightM` — the
 *  top/bottom caps are triangulated with `THREE.ShapeUtils` (simple, non-self-intersecting
 *  polygons only, which is all a takeoff area measurement ever is) and the side walls are one
 *  quad per edge. */
function extrudedPolygonGeometry(points: [number, number][], baseY: number, heightM: number): THREE.BufferGeometry {
  const shapePts = points.map(([x, z]) => new THREE.Vector2(x, z));
  const triangles = THREE.ShapeUtils.triangulateShape(shapePts, []);
  const positions: number[] = [];
  const pushTri = (ia: number, ib: number, ic: number, y: number, flip: boolean) => {
    const seq = flip ? [ic, ib, ia] : [ia, ib, ic];
    for (const idx of seq) {
      const [x, z] = points[idx];
      positions.push(x, y, z);
    }
  };
  for (const [ia, ib, ic] of triangles) {
    pushTri(ia, ib, ic, baseY + heightM, false);
    pushTri(ia, ib, ic, baseY, true);
  }
  const n = points.length;
  for (let i = 0; i < n; i += 1) {
    const [x1, z1] = points[i];
    const [x2, z2] = points[(i + 1) % n];
    positions.push(x1, baseY, z1, x2, baseY, z2, x2, baseY + heightM, z2);
    positions.push(x1, baseY, z1, x2, baseY + heightM, z2, x1, baseY + heightM, z1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.computeVertexNormals();
  return geometry;
}

function AreaMeshItem({ area }: { area: AreaMesh3D }) {
  const geometry = useMemo(
    () => extrudedPolygonGeometry(area.points, area.baseY, area.heightM),
    [area],
  );
  return (
    <mesh geometry={geometry}>
      <meshLambertMaterial color={area.color} side={THREE.DoubleSide} transparent opacity={0.85} />
    </mesh>
  );
}

/** Renders all box-shaped members sharing a `(kind, size)` as a single InstancedMesh — one
 *  geometry, one material, one draw call regardless of how many members are in the group. */
function InstancedMembers({
  kind,
  size,
  color,
  members,
}: {
  kind: Member3D["kind"];
  size: [number, number, number];
  color?: string;
  members: Member3D[];
}) {
  const ref = useRef<THREE.InstancedMesh>(null);

  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const matrix = new THREE.Matrix4();
    const scale = new THREE.Vector3(1, 1, 1);
    members.forEach((mem, i) => {
      const [qx, qy, qz, qw] = quaternionFor(mem.yaw, mem.pitch);
      matrix.compose(new THREE.Vector3(...mem.position), new THREE.Quaternion(qx, qy, qz, qw), scale);
      mesh.setMatrixAt(i, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [members]);

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, members.length]}>
      <boxGeometry args={size} />
      <meshLambertMaterial color={color ?? MEMBER_COLOURS[kind] ?? "#999999"} />
    </instancedMesh>
  );
}

/** Box-shaped members are batched into one InstancedMesh per (kind, size) combination —
 *  this is by far the common case (studs, plates, dwangs, etc.) and collapses what would
 *  otherwise be hundreds of individual draw calls into a handful. Wedges (rake/plumb cuts)
 *  are comparatively rare and each get their own mesh since their geometry is unique. */
function Members({ members, areas }: { members: Member3D[]; areas?: AreaMesh3D[] }) {
  const { wedges, groups } = useMemo(() => {
    const wedges: Member3D[] = [];
    const map = new Map<
      string,
      { kind: Member3D["kind"]; size: [number, number, number]; color?: string; members: Member3D[] }
    >();
    for (const mem of members) {
      if (mem.wedge) {
        wedges.push(mem);
        continue;
      }
      const key = `${mem.kind}|${mem.size.join(",")}|${mem.color ?? ""}`;
      let group = map.get(key);
      if (!group) {
        group = { kind: mem.kind, size: mem.size, color: mem.color, members: [] };
        map.set(key, group);
      }
      group.members.push(mem);
    }
    return { wedges, groups: Array.from(map.values()) };
  }, [members]);

  return (
    <group>
      {wedges.map((mem, i) => (
        <WedgeMesh key={i} mem={mem} />
      ))}
      {groups.map((g, i) => (
        <InstancedMembers key={i} kind={g.kind} size={g.size} color={g.color} members={g.members} />
      ))}
      {areas?.map((area, i) => (
        <AreaMeshItem key={i} area={area} />
      ))}
    </group>
  );
}

/**
 * Loads an image URL into a THREE.Texture, returning null until it's ready.
 *
 * Two things make this finicky in a Tauri webview and both are handled here:
 *  - The preview lives on the `asset.localhost` origin while the app runs on `localhost`. Pointing an
 *    <img> straight at the asset URL loads it for display but *taints* the WebGL context, so the GPU
 *    upload is silently dropped. Fetching the bytes and going through a same-origin `blob:` URL avoids
 *    the taint entirely.
 *  - The PNG is non-power-of-two (1200×849), so mipmaps are disabled (LinearFilter) or WebGL drops it.
 *
 * The texture is fully configured *before* it's handed to React, so the consuming mesh/material is
 * created in one shot with the map already attached (never a null→texture swap, which would leave the
 * basic material compiled without a texture sampler and rendering plain white).
 */
function useImageTexture(url: string | undefined): THREE.Texture | null {
  const [texture, setTexture] = useState<THREE.Texture | null>(null);

  useEffect(() => {
    setTexture(null);
    if (!url) return;

    let alive = true;
    let objectUrl: string | null = null;
    let created: THREE.Texture | null = null;

    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);

        const img = new Image();
        img.onload = () => {
          if (!alive) return;
          created = new THREE.Texture(img);
          created.colorSpace = THREE.SRGBColorSpace;
          created.minFilter = THREE.LinearFilter;
          created.magFilter = THREE.LinearFilter;
          created.generateMipmaps = false;
          created.wrapS = THREE.ClampToEdgeWrapping;
          created.wrapT = THREE.ClampToEdgeWrapping;
          created.needsUpdate = true;
          setTexture(created);
        };
        img.onerror = (e) => console.warn("[useImageTexture] decode failed", url, e);
        img.src = objectUrl;
      } catch (e) {
        console.warn("[useImageTexture] fetch failed", url, e);
      }
    })();

    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (created) created.dispose();
    };
  }, [url]);

  return texture;
}

/** PDF page as a horizontal ground plane at Y≈0. Rendered only once its texture is ready, so the
 *  material is created with the map already set. Coordinate convention: PDF X → world +X,
 *  PDF Y → world -Z; the page occupies X:[0, widthM] × Z:[-heightM, 0]. */
function PageGround({ widthM, heightM, url }: { widthM: number; heightM: number; url: string }) {
  const texture = useImageTexture(url);
  if (!texture) return null;
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[widthM / 2, -0.002, -heightM / 2]}>
      <planeGeometry args={[widthM, heightM]} />
      <meshBasicMaterial map={texture} toneMapped={false} side={THREE.DoubleSide} />
    </mesh>
  );
}

/** One page's contribution to a multi-page 3D scene: its members and (optionally) its PDF
 *  page rendered as a ground plane, translated up by `offsetM` along world Y. */
export interface Framing3DPage {
  members: Member3D[];
  /** Area-group extrusions (flat or volumetric polygons) for this page. */
  areas?: AreaMesh3D[];
  offsetM: number;
  pageWidthM?: number;
  pageHeightM?: number;
  previewUrl?: string;
  /** Whether to render this page's PDF as a ground plane (typically only the offsetM === 0 page). */
  showGround: boolean;
}

interface Framing3DViewProps {
  members: Member3D[];
  /** Area-group extrusions for the single-page view. */
  areas?: AreaMesh3D[];
  /** PDF page width in world metres — when provided with pageHeightM and previewUrl, renders the page as ground. */
  pageWidthM?: number;
  pageHeightM?: number;
  /** Tauri asset URL for the page preview image. */
  previewUrl?: string;
  /** Multi-page 3D scene: when provided (non-empty), takes precedence over the single-page props above. */
  pages?: Framing3DPage[];
}

/** Renders a dimension group's measurements as 3D geometry with orbit/pan/zoom — timber-framing
 *  boxes from `computeWall3D`, and generic markers/extrusions/meshes from the count/length/area
 *  builders in lib/framing3d.ts (world metres, Y up, the PDF page as the floor). */
export function Framing3DView({ members, areas, pageWidthM, pageHeightM, previewUrl, pages }: Framing3DViewProps) {
  const effectivePages: Framing3DPage[] = useMemo(() => {
    if (pages && pages.length > 0) return pages;
    return [{ members, areas, offsetM: 0, pageWidthM, pageHeightM, previewUrl, showGround: true }];
  }, [pages, members, areas, pageWidthM, pageHeightM, previewUrl]);

  const { center, radius, camPos } = useMemo(() => {
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const page of effectivePages) {
      for (const mem of page.members) {
        const offset = new THREE.Vector3(0, page.offsetM, 0);
        if (mem.wedge) {
          const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), mem.yaw);
          for (const [x, y] of mem.wedge.quad) {
            for (const z of [-mem.wedge.depthM / 2, mem.wedge.depthM / 2]) {
              box.expandByPoint(v.set(x, y, z).applyQuaternion(q).add(new THREE.Vector3(...mem.position)).add(offset));
            }
          }
          continue;
        }
        const h = Math.max(...mem.size) / 2 + 0.05;
        box.expandByPoint(v.set(mem.position[0] - h, mem.position[1] - h + page.offsetM, mem.position[2] - h));
        box.expandByPoint(v.set(mem.position[0] + h, mem.position[1] + h + page.offsetM, mem.position[2] + h));
      }
      for (const area of page.areas ?? []) {
        for (const [x, z] of area.points) {
          box.expandByPoint(v.set(x, area.baseY + page.offsetM, z));
          box.expandByPoint(v.set(x, area.baseY + area.heightM + page.offsetM, z));
        }
      }
    }
    if (box.isEmpty()) box.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const r = Math.max(size.x, size.y, size.z, 1);
    return {
      center: [c.x, c.y, c.z] as [number, number, number],
      radius: r,
      camPos: [c.x + r * 1.3, c.y + r * 0.9, c.z + r * 1.3] as [number, number, number],
    };
  }, [effectivePages]);

  return (
    <Canvas
      frameloop="demand"
      dpr={[1, 1.5]}
      camera={{ position: camPos, fov: 45, near: 0.01, far: radius * 30 + 50 }}
      style={{ background: "#dfe4ea" }}
    >
      <ambientLight intensity={0.75} />
      <directionalLight position={[radius, radius * 2.5, radius * 1.5]} intensity={0.85} />
      <directionalLight position={[-radius, radius, -radius]} intensity={0.25} />
      {effectivePages.map((page, i) => {
        const showPage = page.showGround && page.pageWidthM != null && page.pageHeightM != null && page.previewUrl != null;
        return (
          <group key={i} position={[0, page.offsetM, 0]}>
            {showPage && <PageGround widthM={page.pageWidthM!} heightM={page.pageHeightM!} url={page.previewUrl!} />}
            <Members members={page.members} areas={page.areas} />
          </group>
        );
      })}
      <OrbitControls makeDefault target={center} />
    </Canvas>
  );
}
