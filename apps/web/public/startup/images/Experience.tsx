import type { MutableRefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Color, Vector2 } from "three";
import { useFrame } from "@react-three/fiber";
import CreatureBody from "./components/CreatureBody";
import Eye from "./components/Eye";
import Limbs from "./components/Limbs";
import PostFX from "./components/PostFX";
import TextParticles from "./components/TextParticles";
import { CreatureController, type Particle } from "./controller";

interface Props {
  pointer: MutableRefObject<Vector2>;
  ingestionText: string | null;
  onConsume: () => void;
}

export default function Experience({ pointer, ingestionText, onConsume }: Props) {
  const controller = useMemo(() => new CreatureController(6), []);
  const [particles, setParticles] = useState<Pick<Particle, "id" | "char">[]>([]);
  const lastText = useRef<string | null>(null);

  useEffect(() => {
    const colorMgmt = document.body;
    colorMgmt.style.backgroundColor = "#05070e";
  }, []);

  useEffect(() => {
    if (!ingestionText || ingestionText === lastText.current) return;
    lastText.current = ingestionText;
    controller.ingest(ingestionText);
    onConsume();
  }, [controller, ingestionText, onConsume]);

  useFrame((state, dt) => {
    controller.setPointer(pointer.current);
    const changed = controller.update(dt, state.clock.elapsedTime);
    if (changed) {
      setParticles(controller.getParticles().map((p) => ({ id: p.id, char: p.char })));
    }

    state.gl.setClearColor(new Color("#05070e"), 1);
  });

  return (
    <>
      <ambientLight intensity={0.32} />
      <directionalLight position={[3, 4, 2]} intensity={0.9} color="#9ccfff" />
      <directionalLight position={[-2, -1, 1]} intensity={0.35} color="#2e65ff" />
      <pointLight position={[0, -1, 3]} intensity={2.8} color="#ff9a51" />

      <CreatureBody controller={controller} />
      <Limbs controller={controller} />
      <Eye controller={controller} />
      <TextParticles controller={controller} particles={particles} />
      <PostFX />
    </>
  );
}
