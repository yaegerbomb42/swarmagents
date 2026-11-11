'use client';

import React from 'react';

export default function AgentOColorWheel() {
  return (
    <div className="relative w-[340px] h-[340px] flex items-center justify-center bg-transparent select-none">
      <style dangerouslySetInnerHTML={{ __html: `
        @property --spin-wheel { syntax: "<angle>"; inherits: false; initial-value: 0deg; }
        @property --hue-wheel  { syntax: "<angle>"; inherits: false; initial-value: 0deg; }

        .o-wheel-wrap {
          --size: 280px;
          width: var(--size);
          height: var(--size);
          position: relative;
          display: grid;
          place-items: center;
          transform-style: preserve-3d;
          contain: layout paint;
        }

        .o-wheel {
          width: 100%;
          height: 100%;
          border-radius: 50%;
          position: relative;
          display: grid;
          place-items: center;
          isolation: isolate;
          animation:
            oTiltWheel 7.5s ease-in-out infinite,
            hueShiftWheel 9s linear infinite;
          --hue-wheel: 0deg;
          will-change: transform, filter;
          filter: hue-rotate(var(--hue-wheel)) saturate(1.25) contrast(1.08);
        }

        @keyframes oTiltWheel {
          0%, 100% { transform: rotateX(10deg) rotateY(-12deg); }
          50% { transform: rotateX(-6deg) rotateY(10deg); }
        }
        @keyframes hueShiftWheel {
          to { --hue-wheel: 360deg; }
        }

        .o-wheel::before {
          content: "";
          position: absolute;
          inset: 0;
          border-radius: 50%;
          background:
            radial-gradient(circle at 50% 50%, transparent 56%, rgba(255,255,255,.05) 57%, transparent 60%),
            conic-gradient(from var(--spin-wheel),
              rgba(0,255,255,.90),
              rgba(0,140,255,.85),
              rgba(180,0,255,.80),
              rgba(255,0,160,.82),
              rgba(255,140,0,.78),
              rgba(255,230,0,.70),
              rgba(0,255,170,.78),
              rgba(0,255,255,.90)
            );
          -webkit-mask: radial-gradient(circle, transparent 0 57%, #000 58% 100%);
          mask: radial-gradient(circle, transparent 0 57%, #000 58% 100%);
          filter: blur(0.2px);
          opacity: .95;
          animation: rimSpinWheel 6s linear infinite;
          will-change: transform;
        }

        .o-wheel::after {
          content: "";
          position: absolute;
          inset: -26px;
          border-radius: 50%;
          background:
            radial-gradient(circle at 50% 50%,
              rgba(0,255,255,.14),
              rgba(255,0,170,.10) 30%,
              rgba(255,200,0,.08) 45%,
              transparent 70%
            );
          filter: blur(18px);
          opacity: .9;
          z-index: -1;
          animation: haloBreathWheel 3.4s ease-in-out infinite;
        }

        @keyframes rimSpinWheel { to { --spin-wheel: 360deg; } }
        @keyframes haloBreathWheel {
          0%, 100% { transform: scale(1); opacity: .75; }
          50% { transform: scale(1.08); opacity: 1; }
        }

        .inner-wheel {
          width: 58%;
          height: 58%;
          border-radius: 50%;
          position: relative;
          overflow: hidden;
          transform: translateZ(8px);
          box-shadow:
            inset 0 0 0 1px rgba(255,255,255,.06),
            inset 0 -30px 60px rgba(0,0,0,.55),
            0 18px 60px rgba(0,0,0,.45);
          background:
            radial-gradient(circle at 28% 22%, rgba(255,255,255,.35), transparent 40%),
            radial-gradient(circle at 75% 78%, rgba(255,255,255,.18), transparent 46%),
            conic-gradient(from var(--spin-wheel),
              rgba(0,255,255,.20),
              rgba(255,0,170,.18),
              rgba(255,220,0,.16),
              rgba(0,255,170,.16),
              rgba(0,160,255,.18),
              rgba(0,255,255,.20)
            ),
            radial-gradient(circle at 50% 50%, rgba(15,18,30,.95), rgba(5,6,10,1));
          background-blend-mode: screen, screen, color-dodge, normal;
          animation:
            beatWheel 1.6s cubic-bezier(.2,.9,.15,1) infinite,
            innerSpinWheel 5.5s linear infinite;
          will-change: transform, filter;
          filter: saturate(1.35) contrast(1.08);
        }

        @keyframes beatWheel {
          0%, 50%, 100% { transform: translateZ(8px) scale(1); }
          10% { transform: translateZ(10px) scale(1.06); }
          22% { transform: translateZ(7px) scale(0.985); }
          35% { transform: translateZ(9px) scale(1.03); }
        }
        @keyframes innerSpinWheel { to { --spin-wheel: 360deg; } }

        .inner-wheel::before {
          content: "";
          position: absolute;
          inset: -18%;
          border-radius: 50%;
          background:
            repeating-radial-gradient(circle at 50% 50%,
              rgba(255,255,255,0) 0 7px,
              rgba(0,255,255,.10) 7px 8px,
              rgba(255,0,170,.08) 8px 9px,
              rgba(255,255,255,0) 9px 18px
            ),
            repeating-conic-gradient(from calc(var(--spin-wheel) * 1.25),
              rgba(255,255,255,0) 0 8deg,
              rgba(255,255,255,.06) 8deg 9deg,
              rgba(0,255,255,0) 9deg 18deg
            );
          background-blend-mode: screen;
          filter: blur(1.2px) contrast(1.15);
          opacity: .9;
          transform: rotate(0deg);
          animation:
            rippleDriftWheel 2.8s ease-in-out infinite,
            rippleSpinWheel 1.8s linear infinite;
          will-change: transform, opacity;
          mix-blend-mode: screen;
        }

        @keyframes rippleSpinWheel { to { transform: rotate(360deg); } }
        @keyframes rippleDriftWheel {
          0%, 100% { opacity: .55; filter: blur(1.1px) contrast(1.15); }
          50% { opacity: .95; filter: blur(0.6px) contrast(1.3); }
        }

        .specular-wheel {
          position: absolute;
          inset: -30%;
          border-radius: 50%;
          background: linear-gradient(
            115deg,
            transparent 0%,
            rgba(255,255,255,0) 35%,
            rgba(255,255,255,.22) 45%,
            rgba(255,255,255,.08) 52%,
            rgba(255,255,255,0) 60%,
            transparent 100%
          );
          transform: rotate(-18deg) translateX(-40%);
          animation: sweepWheel 2.6s ease-in-out infinite;
          mix-blend-mode: screen;
          pointer-events: none;
          filter: blur(0.6px);
          opacity: .75;
        }
        @keyframes sweepWheel {
          0%, 100% { transform: rotate(-18deg) translateX(-45%); opacity: .45; }
          50% { transform: rotate(-18deg) translateX(45%); opacity: .90; }
        }

        .droplet-wheel {
          position: absolute;
          left: 50%; top: 50%;
          width: 12px; height: 12px;
          border-radius: 50%;
          border: 2px solid rgba(255,255,255,.15);
          box-shadow: 0 0 25px rgba(0,255,255,.25);
          transform: translate(-50%,-50%) scale(.2);
          opacity: 0;
          animation: dropWheel 2.4s ease-out infinite;
          mix-blend-mode: screen;
          pointer-events: none;
        }
        @keyframes dropWheel {
          0% { opacity: 0; transform: translate(-50%,-50%) scale(.2); }
          8% { opacity: .85; }
          55% { opacity: .28; transform: translate(-50%,-50%) scale(10); }
          100% { opacity: 0; transform: translate(-50%,-50%) scale(14); }
        }

        .lens-wheel {
          position: absolute;
          inset: 18%;
          border-radius: 50%;
          background:
            radial-gradient(circle at 50% 40%, rgba(255,255,255,.10), transparent 60%),
            radial-gradient(circle at 30% 70%, rgba(0,255,255,.12), transparent 55%),
            radial-gradient(circle at 70% 72%, rgba(255,0,170,.10), transparent 55%);
          filter: blur(1.2px);
          opacity: .85;
          animation: lensWobbleWheel 1.6s ease-in-out infinite;
          mix-blend-mode: screen;
          pointer-events: none;
        }
        @keyframes lensWobbleWheel {
          0%, 100% { transform: translate(0,0) scale(1); }
          30% { transform: translate(2px,-3px) scale(1.03); }
          60% { transform: translate(-2px,2px) scale(0.99); }
        }
      ` }} />

      <div className="o-wheel-wrap">
        <div className="o-wheel">
          <div className="inner-wheel">
            <div className="specular-wheel" />
            <div className="lens-wheel" />
            <div className="droplet-wheel" />
          </div>
        </div>
      </div>
    </div>
  );
}
