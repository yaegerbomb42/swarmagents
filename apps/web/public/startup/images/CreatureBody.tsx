import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useFBO } from "@react-three/drei";
import * as THREE from "three";
import type { CreatureController } from "../controller";
import { backdropFragment, backdropVertex, bodyFragment, bodyVertex } from "../shaders/body";

const MAX_LIMBS = 8;

interface Props {
  controller: CreatureController;
}

export default function CreatureBody({ controller }: Props) {
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const backdropSceneRef = useRef<THREE.Scene | null>(null);
  const backdropMatRef = useRef<THREE.ShaderMaterial | null>(null);
  const backdropGeoRef = useRef<THREE.PlaneGeometry | null>(null);
  const { viewport } = useThree();

  const limbCenters = useMemo(() => Array.from({ length: MAX_LIMBS }, () => new THREE.Vector3()), []);
  const limbPulse = useMemo(() => new Float32Array(MAX_LIMBS).fill(0), []);

  const [uniforms] = useState(() => ({
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uRefraction: { value: null as THREE.Texture | null },
    uBodyPos: { value: new THREE.Vector3() },
    uEyePos: { value: new THREE.Vector3() },
    uBodyScale: { value: 1 },
    uLimbCenters: { value: limbCenters },
    uLimbPulse: { value: limbPulse },
    uLimbCount: { value: 0 },
    uInvProjection: { value: new THREE.Matrix4() },
    uInvView: { value: new THREE.Matrix4() }
  }));

  const backCamera = useMemo(() => {
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
    cam.position.z = 1;
    return cam;
  }, []);

  const fbo = useFBO({ samples: 4, depthBuffer: false });

  useEffect(() => {
    const scene = new THREE.Scene();
    const geo = new THREE.PlaneGeometry(2, 2);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }
      },
      vertexShader: backdropVertex,
      fragmentShader: backdropFragment,
      depthWrite: false
    });
    scene.add(new THREE.Mesh(geo, mat));
    backdropSceneRef.current = scene;
    backdropMatRef.current = mat;
    backdropGeoRef.current = geo;

    return () => {
      mat.dispose();
      geo.dispose();
      fbo.dispose();
    };
  }, [fbo]);

  useFrame((state) => {
    const snap = controller.snapshot;
    const material = matRef.current;
    if (!material) return;

    if (backdropSceneRef.current && backdropMatRef.current) {
      backdropMatRef.current.uniforms.uTime.value = state.clock.elapsedTime;
      state.gl.setRenderTarget(fbo);
      state.gl.render(backdropSceneRef.current, backCamera);
      state.gl.setRenderTarget(null);
    }

    material.uniforms.uRefraction.value = fbo.texture;
    material.uniforms.uTime.value = state.clock.elapsedTime;
    material.uniforms.uResolution.value.set(
      state.size.width * state.gl.getPixelRatio(),
      state.size.height * state.gl.getPixelRatio()
    );
    material.uniforms.uBodyPos.value.copy(snap.bodyPosition);
    material.uniforms.uEyePos.value.copy(snap.eyePosition);
    material.uniforms.uBodyScale.value = snap.bodyScale;
    material.uniforms.uLimbCount.value = snap.limbs.length;
    snap.limbs.forEach((limb, i) => {
      if (!limbCenters[i]) return;
      limbCenters[i].copy(limb.position);
      limbPulse[i] = limb.pulse;
    });
    material.uniformsNeedUpdate = true;

    material.uniforms.uInvProjection.value.copy(state.camera.projectionMatrixInverse);
    material.uniforms.uInvView.value.copy(state.camera.matrixWorld);
  });

  return (
    <mesh position={[0, 0, 0]} scale={[viewport.width, viewport.height, 1]} frustumCulled={false}>
      <planeGeometry args={[1, 1, 1, 1]} />
      <shaderMaterial
        ref={matRef}
        vertexShader={bodyVertex}
        fragmentShader={bodyFragment}
        uniforms={uniforms}
        transparent={false}
        depthWrite
      />
    </mesh>
  );
}
