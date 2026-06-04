import { useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { Grid, OrbitControls } from "@react-three/drei";
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

/** Renders timber-framing members as 3D boxes with orbit/pan/zoom. Members come from
 *  `computeWall3D` (world metres, Y up, the PDF page as the floor). */
export function Framing3DView({ members }: { members: Member3D[] }) {
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

  return (
    <Canvas camera={{ position: camPos, fov: 45, near: 0.01, far: radius * 30 + 50 }} style={{ background: "#dfe4ea" }}>
      <ambientLight intensity={0.75} />
      <directionalLight position={[radius, radius * 2.5, radius * 1.5]} intensity={0.85} />
      <directionalLight position={[-radius, radius, -radius]} intensity={0.25} />
      <Grid
        position={[center[0], 0, center[2]]}
        args={[radius * 8, radius * 8]}
        cellSize={1}
        cellThickness={0.6}
        cellColor="#b6bec6"
        sectionSize={5}
        sectionThickness={1}
        sectionColor="#93a3b3"
        infiniteGrid
        fadeDistance={radius * 16}
        fadeStrength={1}
      />
      <Members members={members} />
      <OrbitControls makeDefault target={center} />
    </Canvas>
  );
}
