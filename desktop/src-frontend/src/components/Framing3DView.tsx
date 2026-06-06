import { useEffect, useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { MEMBER_COLOURS, type Member3D } from "../lib/framing3d";

/** Compose the member's yaw (about world-up) and pitch (about its local across-axis) into a quaternion. */
function quaternionFor(yaw: number, pitch: number): [number, number, number, number] {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  if (pitch) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), pitch));
  return [q.x, q.y, q.z, q.w];
}

function Members({ members }: { members: Member3D[] }) {
  return (
    <group>
      {members.map((mem, i) => (
        <mesh key={i} position={mem.position} quaternion={quaternionFor(mem.yaw, mem.pitch)}>
          <boxGeometry args={mem.size} />
          <meshStandardMaterial color={MEMBER_COLOURS[mem.kind] ?? "#999999"} />
        </mesh>
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

interface Framing3DViewProps {
  members: Member3D[];
  /** PDF page width in world metres — when provided with pageHeightM and previewUrl, renders the page as ground. */
  pageWidthM?: number;
  pageHeightM?: number;
  /** Tauri asset URL for the page preview image. */
  previewUrl?: string;
}

/** Renders timber-framing members as 3D boxes with orbit/pan/zoom. Members come from
 *  `computeWall3D` (world metres, Y up, the PDF page as the floor). */
export function Framing3DView({ members, pageWidthM, pageHeightM, previewUrl }: Framing3DViewProps) {
  const { center, radius, camPos } = useMemo(() => {
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const mem of members) {
      const h = Math.max(...mem.size) / 2 + 0.05;
      box.expandByPoint(v.set(mem.position[0] - h, mem.position[1] - h, mem.position[2] - h));
      box.expandByPoint(v.set(mem.position[0] + h, mem.position[1] + h, mem.position[2] + h));
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
  }, [members]);

  const showPage = pageWidthM != null && pageHeightM != null && previewUrl != null;

  return (
    <Canvas camera={{ position: camPos, fov: 45, near: 0.01, far: radius * 30 + 50 }} style={{ background: "#dfe4ea" }}>
      <ambientLight intensity={0.75} />
      <directionalLight position={[radius, radius * 2.5, radius * 1.5]} intensity={0.85} />
      <directionalLight position={[-radius, radius, -radius]} intensity={0.25} />
      {/* Grid as spatial reference; the PDF plane (when present) sits just above it. */}
      <gridHelper
        args={[radius * 8, Math.round(radius * 8), "#b6bec6", "#93a3b3"]}
        position={[center[0], -0.004, center[2]]}
      />
      {showPage && <PageGround widthM={pageWidthM!} heightM={pageHeightM!} url={previewUrl!} />}
      <Members members={members} />
      <OrbitControls makeDefault target={center} />
    </Canvas>
  );
}
