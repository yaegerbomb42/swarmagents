'use client';

import React, { useRef, useState, useCallback } from 'react';

type MagneticTiltProps = {
  children: React.ReactNode;
  className?: string;
  intensity?: number;
  glare?: boolean;
};

/** 3D perspective tilt + optional glare following cursor */
export default function MagneticTilt({
  children,
  className = '',
  intensity = 12,
  glare = true,
}: MagneticTiltProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({});
  const [glarePos, setGlarePos] = useState({ x: 50, y: 50, opacity: 0 });

  const onMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      const rotY = (x - 0.5) * intensity;
      const rotX = (0.5 - y) * intensity;

      setStyle({
        transform: `perspective(800px) rotateX(${rotX}deg) rotateY(${rotY}deg) scale3d(1.02, 1.02, 1.02)`,
      });
      setGlarePos({ x: x * 100, y: y * 100, opacity: 0.35 });
    },
    [intensity],
  );

  const onLeave = useCallback(() => {
    setStyle({ transform: 'perspective(800px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)' });
    setGlarePos((g) => ({ ...g, opacity: 0 }));
  }, []);

  return (
    <div
      ref={ref}
      className={`magnetic-tilt ${className}`}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      style={style}
    >
      {glare ? (
        <div
          className="magnetic-tilt__glare"
          aria-hidden
          style={{
            background: `radial-gradient(circle at ${glarePos.x}% ${glarePos.y}%, rgba(255,255,255,0.12), transparent 55%)`,
            opacity: glarePos.opacity,
          }}
        />
      ) : null}
      <div className="relative z-[1]">{children}</div>
    </div>
  );
}
