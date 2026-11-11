import { Canvas } from "@react-three/fiber";
import { Suspense, type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import Experience from "./scene/Experience";
import "./App.css";

export default function App() {
  const pointer = useRef(new THREE.Vector2());
  const [text, setText] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      const nx = (e.clientX / window.innerWidth) * 2 - 1;
      const ny = -((e.clientY / window.innerHeight) * 2 - 1);
      pointer.current.set(nx, ny);
    };
    window.addEventListener("pointermove", handleMove, { passive: true });
    return () => window.removeEventListener("pointermove", handleMove);
  }, []);

  const submit = (value: string) => {
    const cleaned = value.trim().slice(0, 160);
    if (!cleaned) return;
    setPending(cleaned);
    setText("");
  };

  const formSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    submit(text);
  };

  const experienceKey = useMemo(() => "living-ui-creature", []);

  return (
    <div className="app-shell">
      <Canvas
        key={experienceKey}
        dpr={[1, 2]}
        camera={{ fov: 45, position: [0, 0.2, 4], near: 0.1, far: 30 }}
        gl={{ powerPreference: "high-performance", antialias: true }}
      >
        <Suspense fallback={null}>
          <Experience
            pointer={pointer}
            ingestionText={pending}
            onConsume={() => setPending(null)}
          />
        </Suspense>
      </Canvas>

      <div className="hud">
        <div className="title">
          <div className="pill">Living UI</div>
          <h1>Bioluminescent Creature</h1>
          <p>Type and press Enter to feed it. Desktop only.</p>
        </div>

        <form className="glass-bar" onSubmit={formSubmit}>
          <input
            type="text"
            placeholder="Whisper data into the abyss..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={200}
            aria-label="creature prompt input"
          />
          <button type="submit">Ingest</button>
        </form>

        <div className="hint">
          Phase A: stream → Phase B: orbit → Phase C: categorize → Phase D:
          morph
        </div>
      </div>
    </div>
  );
}
