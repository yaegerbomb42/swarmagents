import { Bloom, ChromaticAberration, EffectComposer, Vignette } from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";

export default function PostFX() {
  return (
    <EffectComposer multisampling={4}>
      <Bloom mipmapBlur luminanceThreshold={0.12} intensity={0.9} radius={0.8} />
      <ChromaticAberration offset={[0.0008, 0.0006]} />
      <Vignette eskil={false} offset={0.28} darkness={0.65} blendFunction={BlendFunction.NORMAL} />
    </EffectComposer>
  );
}
