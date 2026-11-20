"use client";

/**
 * MascotSvg — the second Jimmy renderer, ported from
 * public/brand/mascot/mascot-svg-reference.html.
 *
 * The reference is a 10 second procedural SVG/JS animation with three
 * gestures. `state` chooses which sub-range of that timeline loops, so the
 * mascot only ever performs the gesture that matches the run:
 *
 *   wave      0-3s   greeting / nothing running yet
 *   curious   3-6s   waiting for the user or an ask_user question
 *   thinking  6-10s  an agent run is active
 *   idle      1.3-2.9s  the calm shoulder of the opening segment, with the
 *                       arm rig pinned to rest (breathing + eye glow only)
 *
 * Playback uses requestAnimationFrame, stops while the tab is hidden, and is
 * cancelled on unmount. With `prefers-reduced-motion` it renders a still
 * frame at the start of the state's segment instead.
 *
 * No grey stage: the SVG itself is transparent. All gradient, filter, clip
 * and path ids are prefixed with React's useId, so two mascots on one page
 * cannot reference (or override) each other's defs.
 */

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  MASCOT_SVG_ASPECT,
  segmentFor,
  timelineTimeFor,
  type MascotSvgState,
} from "./svg-timeline";

export interface MascotSvgProps {
  /** Which gesture segment to loop. Defaults to idle. */
  state?: MascotSvgState;
  /** Width of the artwork in CSS pixels; the height follows the 540:640 viewBox. */
  size?: number;
  /** When provided, the mascot is clickable (and waves when clicked). */
  onClick?: () => void;
  /** Optional visually hidden status line, announced politely to screen readers. */
  label?: string;
  /** Accessible name for the click target. Defaults to "Wave hello". */
  clickLabel?: string;
  className?: string;
  /** Test override for the `prefers-reduced-motion` media query. */
  reducedMotion?: boolean;
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(REDUCED_MOTION_QUERY).matches,
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(REDUCED_MOTION_QUERY);
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  return reduced;
}

/* -------------------------------------------------------------------------- */
/* Timeline engine (ported from the reference's E / tr / ik helpers)          */
/* -------------------------------------------------------------------------- */

type EaseName = "io" | "sine" | "sp";
type Keyframe = readonly [number, number, EaseName?];
type Track = readonly Keyframe[];

const TAU = Math.PI * 2;

const EASE: Record<EaseName, (u: number) => number> = {
  io: (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2),
  sine: (u) => -(Math.cos(Math.PI * u) - 1) / 2,
  sp: (u) => (u >= 1 ? 1 : 1 - Math.exp(-7.5 * u) * (Math.cos(10 * u) + 0.75 * Math.sin(10 * u))),
};

/** Sample a keyframe track at timeline time `t`. */
function trackValue(track: Track, t: number): number {
  if (t <= track[0][0]) return track[0][1];
  for (let i = 1; i < track.length; i += 1) {
    if (t <= track[i][0]) {
      const a = track[i - 1];
      const b = track[i];
      const ease = EASE[b[2] ?? "io"];
      return a[1] + (b[1] - a[1]) * ease((t - a[0]) / (b[0] - a[0]));
    }
  }
  return track[track.length - 1][1];
}

/**
 * Two-bone IK, used once at module load to find the pondering pose that puts
 * the left hand at the chin plate. Angles are in degrees.
 */
function solveIk(
  shoulderX: number,
  shoulderY: number,
  scale: number,
  targetX: number,
  targetY: number,
  upperLength: number,
  lowerLength: number,
): [number, number] {
  const x = (targetX - shoulderX) * scale;
  const y = targetY - shoulderY;
  const distance = Math.min(
    Math.max(Math.hypot(x, y), Math.abs(upperLength - lowerLength) + 1),
    upperLength + lowerLength - 1,
  );
  const phi = Math.atan2(x, y);
  const interior = Math.acos(
    (upperLength * upperLength + distance * distance - lowerLength * lowerLength) /
      (2 * upperLength * distance),
  );
  let best: { r: number; ex: number; ey: number } | null = null;
  for (const sign of [-1, 1]) {
    const r = phi + sign * interior;
    const ey = upperLength * Math.cos(r);
    if (!best || ey > best.ey) best = { r, ex: upperLength * Math.sin(r), ey };
  }
  const elbowRoot = best ?? { r: phi, ex: 0, ey: 0 };
  let elbow = Math.atan2(x - elbowRoot.ex, y - elbowRoot.ey) - elbowRoot.r;
  elbow = Math.atan2(Math.sin(elbow), Math.cos(elbow));
  return [(elbowRoot.r * 180) / Math.PI, (elbow * 180) / Math.PI];
}

const K: Record<string, Track> = {
  tilt: [
    [0, 0], [0.4, -1.8], [1.3, 3.2, "sp"], [2.9, 3.2], [3.9, 0],
  ],
  scale: [
    [0, 1], [3.2, 1], [4.4, 1.04, "sp"], [5.9, 1.04], [6.9, 1],
  ],
  headTilt: [
    [0, 0], [1.3, -2.5, "sp"], [3, -2.5], [3.4, -4], [4.5, 15, "sp"],
    [5.2, 13, "sine"], [5.7, 16, "sine"], [6, 15, "sine"], [7, -2, "sp"],
    [7.7, 0], [8.5, -1.5, "sine"], [9.3, 0.5, "sine"], [10, 0],
  ],
  headScale: [
    [0, 1], [3.4, 1], [4.5, 1.05, "sp"], [6, 1.05], [7, 1],
  ],
  headDrop: [
    [0, 0], [6, 0], [7, 4], [9.2, 4], [10, 0],
  ],
  gazeX: [
    [0, 0], [3.4, 0], [4.2, 6], [4.9, -6, "sine"], [5.6, 5, "sine"],
    [6.3, 0], [7.6, -4], [9.4, -4], [10, 0],
  ],
  gazeY: [
    [0, 0], [7, 0], [7.9, -6], [9.2, -6], [10, 0],
  ],
  think: [
    [0, 0], [6, 0], [7, 1], [9, 1], [10, 0],
  ],
  curious: [
    [0, 0], [3.2, 0], [3.8, 1], [5.8, 1], [6.4, 0],
  ],
  rightShoulder: [
    [0, 8], [0.35, -6], [1.25, 105, "sp"], [2.95, 105], [3.9, 8],
  ],
  rightElbow: [
    [0, 6], [0.35, 0], [1.25, 62, "sp"], [1.55, 100, "sine"], [1.9, 40, "sine"],
    [2.25, 100, "sine"], [2.6, 40, "sine"], [2.95, 62, "sine"], [3.9, 6],
  ],
} as const satisfies Record<string, Track>;

const [PONDER_SHOULDER, PONDER_ELBOW] = solveIk(288, 398, -1, 356, 374, 78, 82);

const LEFT_SHOULDER: Track = [
  [0, 8], [6, 8], [7.2, PONDER_SHOULDER, "sp"], [9.2, PONDER_SHOULDER], [10, 8],
];
const LEFT_ELBOW: Track = [
  [0, 6], [6, 6], [7.2, PONDER_ELBOW, "sp"], [8.1, PONDER_ELBOW + 5, "sine"],
  [8.8, PONDER_ELBOW - 2, "sine"], [9.2, PONDER_ELBOW, "sine"], [10, 6],
];

const REST_SHOULDER = 8;
const REST_ELBOW = 6;

interface Pose {
  root: string;
  head: string;
  shadow: string;
  shadowOpacity: string;
  slit: string;
  glowOpacity: string;
  litOpacity: string;
  planes: { transform: string; opacity: string }[];
  rightArm: { shoulder: string; elbow: string };
  leftArm: { shoulder: string; elbow: string };
}

function fixed(value: number, digits: number): string {
  return value.toFixed(digits);
}

/** Evaluate every animated channel at timeline time `t`. */
function poseAt(state: MascotSvgState, t: number): Pose {
  const think = trackValue(K.think, t);
  const scale = trackValue(K.scale, t);
  const tilt = trackValue(K.tilt, t);
  const breath = Math.sin(TAU * 0.3 * t) * (0.008 + 0.006 * think);
  const bob = -4 * think * (0.5 + 0.5 * Math.sin(TAU * 0.2 * t - 1.2));
  const up = -bob;

  const root =
    `translate(0 ${fixed(bob, 2)}) translate(400 666) rotate(${fixed(tilt, 3)}) ` +
    `scale(${fixed(scale * (1 - breath * 0.4), 4)} ${fixed(scale * (1 + breath), 4)}) ` +
    `translate(-400 -666)`;

  const headDrop = trackValue(K.headDrop, t);
  const headTilt = trackValue(K.headTilt, t);
  const headScale = trackValue(K.headScale, t);
  const head =
    `translate(0 ${fixed(headDrop, 2)}) translate(400 352) rotate(${fixed(headTilt, 3)}) ` +
    `scale(${fixed(headScale, 4)}) translate(-400 -352)`;

  const shadow =
    `translate(${fixed(tilt * 2.2, 2)} 0) translate(400 670) ` +
    `scale(${fixed((1 - up * 0.02) * (1 + (scale - 1) * 1.6), 3)} ${fixed(1 - up * 0.02, 3)}) ` +
    `translate(-400 -670)`;
  const shadowOpacity = fixed(1 - up * 0.05, 3);

  // Arms sway gently even at rest. The idle segment sits in the wave window,
  // where the reference has the right arm raised, so pin both arms to rest.
  const sway = 1.4 * Math.sin(TAU * 0.3 * t);
  const idle = state === "idle";
  const rightShoulder = idle ? REST_SHOULDER + sway : trackValue(K.rightShoulder, t) + sway;
  const rightElbow = idle ? REST_ELBOW : trackValue(K.rightElbow, t);
  const leftShoulder = idle ? REST_SHOULDER - sway * 0.7 : trackValue(LEFT_SHOULDER, t) - sway * 0.7;
  const leftElbow = idle ? REST_ELBOW : trackValue(LEFT_ELBOW, t);

  const gazeX = trackValue(K.gazeX, t);
  const gazeY = trackValue(K.gazeY, t);

  // Optical slit: calm glow, flickering curiosity, slow dim pulse while thinking.
  const curious = trackValue(K.curious, t);
  const flicker =
    0.14 * Math.sin(TAU * 3.2 * t) +
    0.07 * Math.sin(TAU * 8.7 * t + 1) +
    0.04 * Math.sin(TAU * 17 * t);
  const intensity = Math.min(
    1,
    Math.max(
      0,
      (1 - think) * (0.8 + 0.04 * Math.sin(TAU * 0.4 * t)) +
        think * (0.58 + 0.1 * Math.sin(TAU * 0.6 * t)) +
        curious * flicker,
    ),
  );

  const planeWeight = 0.25 + 0.75 * think;
  const planes = [0, 1, 2].map((index) => {
    const phase = index * 2.1;
    return {
      transform:
        `translate(${fixed(3 * planeWeight * Math.sin(TAU * 0.3 * t + phase), 2)} ` +
        `${fixed(2.5 * planeWeight * Math.cos(TAU * 0.4 * t + phase), 2)})`,
      opacity: fixed(0.7 + 0.3 * Math.sin(TAU * 0.3 * t + phase * 1.7), 3),
    };
  });

  return {
    root,
    head,
    shadow,
    shadowOpacity,
    slit: `translate(${fixed(gazeX, 2)} ${fixed(gazeY, 2)})`,
    glowOpacity: fixed(0.1 + 0.65 * intensity, 3),
    litOpacity: fixed(0.5 * intensity, 3),
    planes,
    rightArm: { shoulder: fixed(-rightShoulder, 2), elbow: fixed(-rightElbow, 2) },
    leftArm: { shoulder: fixed(-leftShoulder, 2), elbow: fixed(-leftElbow, 2) },
  };
}

/* -------------------------------------------------------------------------- */
/* Unique per-instance SVG ids                                                */
/* -------------------------------------------------------------------------- */

export interface MascotSvgIds {
  shell: string;
  limb: string;
  limbR: string;
  rim: string;
  creamV: string;
  glass: string;
  shadowG: string;
  blur6: string;
  blur3: string;
  faceClip: string;
  headClip: string;
  rimClip: string;
  leg: string;
}

const ID_PARTS = [
  "shell",
  "limb",
  "limbR",
  "rim",
  "creamV",
  "glass",
  "shadowG",
  "blur6",
  "blur3",
  "faceClip",
  "headClip",
  "rimClip",
  "leg",
] as const;

/**
 * Turn React's useId output into a collision-free SVG id prefix. useId returns
 * values like ":r0:"; those are legal HTML ids but awkward inside url(#...),
 * so keep only characters that are safe in both an id and a CSS selector.
 */
export function mascotSvgIdPrefix(rawId: string): string {
  const safe = rawId.replace(/[^a-zA-Z0-9_-]/g, "");
  return safe.length > 0 ? `mascot-${safe}` : "mascot";
}

/** All unique ids for one instance, derived from its useId prefix. */
export function mascotSvgIds(prefix: string): MascotSvgIds {
  return {
    shell: `${prefix}-shell`,
    limb: `${prefix}-limb`,
    limbR: `${prefix}-limbR`,
    rim: `${prefix}-rim`,
    creamV: `${prefix}-creamV`,
    glass: `${prefix}-glass`,
    shadowG: `${prefix}-shadowG`,
    blur6: `${prefix}-b6`,
    blur3: `${prefix}-b3`,
    faceClip: `${prefix}-faceClip`,
    headClip: `${prefix}-headClip`,
    rimClip: `${prefix}-rimClip`,
    leg: `${prefix}-leg`,
  };
}

/* -------------------------------------------------------------------------- */
/* Component                                                                  */
/* -------------------------------------------------------------------------- */

export function MascotSvg({
  state = "idle",
  size = 56,
  onClick,
  label,
  clickLabel,
  className,
  reducedMotion,
}: MascotSvgProps) {
  const rawId = useId();
  const ids = useMemo(() => mascotSvgIds(mascotSvgIdPrefix(rawId)), [rawId]);
  const prefersReduced = usePrefersReducedMotion();
  const motionReduced = reducedMotion ?? prefersReduced;

  const [time, setTime] = useState(() => segmentFor(state).start);
  const previousState = useRef(state);

  // A new state restarts at the first frame of its segment.
  useEffect(() => {
    if (previousState.current === state) return;
    previousState.current = state;
    setTime(segmentFor(state).start);
  }, [state]);

  useEffect(() => {
    if (motionReduced) {
      setTime(segmentFor(state).start);
      return;
    }
    if (typeof window === "undefined" || typeof requestAnimationFrame !== "function") return;

    let frame = 0;
    let startedAt: number | null = null;
    let running = false;

    const tick = (now: number) => {
      if (!running) return;
      if (startedAt === null) startedAt = now;
      setTime(timelineTimeFor(state, now - startedAt));
      frame = requestAnimationFrame(tick);
    };
    const start = () => {
      if (running) return;
      running = true;
      frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(frame);
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    // Pause while the tab is hidden; resume without flashing a stale frame.
    if (document.hidden) stop();
    else start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [state, motionReduced]);

  const pose = poseAt(state, time);
  const height = Math.round(size * MASCOT_SVG_ASPECT);
  const fill = (id: string) => `url(#${id})`;

  const art = (
    <svg
      data-testid="mascot-svg-art"
      viewBox="130 70 540 640"
      width={size}
      height={height}
      role="img"
      aria-hidden="true"
      focusable="false"
      style={{ display: "block", width: size, height, background: "transparent" }}
    >
      <defs>
        <radialGradient id={ids.shell} cx=".35" cy=".25" r=".95">
          <stop offset="0" stopColor="#4d5366" />
          <stop offset=".55" stopColor="#2b2f3b" />
          <stop offset="1" stopColor="#171922" />
        </radialGradient>
        <linearGradient id={ids.limb} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#4a5062" />
          <stop offset=".5" stopColor="#2b2f3b" />
          <stop offset=".88" stopColor="#1d2029" />
          <stop offset="1" stopColor="#3a4d6e" />
        </linearGradient>
        <linearGradient id={ids.limbR} x1="1" y1="0" x2="0" y2="0">
          <stop offset="0" stopColor="#4a5062" />
          <stop offset=".5" stopColor="#2b2f3b" />
          <stop offset=".88" stopColor="#1d2029" />
          <stop offset="1" stopColor="#3a4d6e" />
        </linearGradient>
        <linearGradient id={ids.rim} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a9c0e0" stopOpacity=".5" />
          <stop offset=".4" stopColor="#a9c0e0" stopOpacity="0" />
          <stop offset=".72" stopColor="#7fa2d4" stopOpacity="0" />
          <stop offset="1" stopColor="#8fb4ec" stopOpacity=".95" />
        </linearGradient>
        <linearGradient id={ids.creamV} gradientUnits="userSpaceOnUse" x1="0" y1="120" x2="0" y2="610">
          <stop offset="0" stopColor="#f4e7cf" />
          <stop offset=".5" stopColor="#e9d5b1" />
          <stop offset="1" stopColor="#d2b993" />
        </linearGradient>
        <linearGradient id={ids.glass} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#6b6b70" />
          <stop offset=".5" stopColor="#a7a39d" />
          <stop offset="1" stopColor="#5b5c61" />
        </linearGradient>
        <radialGradient id={ids.shadowG}>
          <stop offset="0" stopColor="#000" stopOpacity=".5" />
          <stop offset=".6" stopColor="#000" stopOpacity=".22" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </radialGradient>
        <filter id={ids.blur6} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
        <filter id={ids.blur3} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
        <clipPath id={ids.faceClip}>
          <ellipse cx="400" cy="262" rx="80" ry="135" />
        </clipPath>
        <clipPath id={ids.headClip}>
          <ellipse cx="400" cy="246" rx="116" ry="142" />
        </clipPath>
        <clipPath id={ids.rimClip}>
          <rect x="250" y="80" width="300" height="250" />
        </clipPath>
        <path
          id={ids.leg}
          d="M350 575 L396 575 L394 640 C394 660 385 668 372 668 C358 668 347 660 348 640 Z"
          fill={fill(ids.limb)}
        />
      </defs>

      <g transform={pose.shadow} opacity={pose.shadowOpacity}>
        <ellipse cx="400" cy="670" rx="122" ry="19" fill={fill(ids.shadowG)} />
        <ellipse cx="400" cy="668" rx="70" ry="7" fill="#000" opacity=".35" filter={fill(ids.blur3)} />
      </g>

      <g transform={pose.root}>
        <use href={`#${ids.leg}`} />
        <use href={`#${ids.leg}`} x="56" />

        <g>
          <ellipse cx="400" cy="450" rx="124" ry="175" fill={fill(ids.shell)} />
          <ellipse cx="318" cy="430" rx="20" ry="88" fill="#fff" opacity=".07" filter={fill(ids.blur6)} />
          <ellipse cx="400" cy="450" rx="124" ry="175" fill="none" stroke={fill(ids.rim)} strokeWidth="3" />
        </g>

        <g transform={pose.head}>
          <ellipse cx="400" cy="246" rx="116" ry="142" fill={fill(ids.shell)} />
          <g clipPath={`url(#${ids.headClip})`}>
            <ellipse cx="352" cy="160" rx="34" ry="20" fill="#fff" opacity=".14" filter={fill(ids.blur6)} transform="rotate(-28 352 160)" />
          </g>
          <ellipse cx="400" cy="246" rx="116" ry="142" fill="none" stroke={fill(ids.rim)} strokeWidth="3" clipPath={`url(#${ids.rimClip})`} />
          <ellipse cx="400" cy="262" rx="80" ry="135" fill={fill(ids.creamV)} />
          <g clipPath={`url(#${ids.faceClip})`}>
            <g transform={pose.planes[0].transform} opacity={pose.planes[0].opacity}>
              <path d="M322 170 L392 132 L380 300 L330 330 Z" fill="#fff" opacity=".13" />
            </g>
            <g transform={pose.planes[1].transform} opacity={pose.planes[1].opacity}>
              <path d="M470 190 L490 300 L430 390 L440 260 Z" fill="#7b5c33" opacity=".1" />
            </g>
            <g transform={pose.planes[2].transform} opacity={pose.planes[2].opacity}>
              <path d="M340 300 L460 270 L450 345 L350 360 Z" fill="#fff" opacity=".09" />
            </g>
            <ellipse cx="362" cy="200" rx="24" ry="62" fill="#fff" opacity=".22" filter={fill(ids.blur6)} />
          </g>
          <g transform={pose.slit}>
            <rect id={`${ids.shell}-glow`} x="376" y="154" width="48" height="88" rx="24" fill="#ffd9a0" filter={fill(ids.blur6)} opacity={pose.glowOpacity} />
            <rect x="383" y="162" width="34" height="68" rx="17" fill="#23252d" />
            <rect x="387" y="167" width="26" height="58" rx="13" fill={fill(ids.glass)} />
            <rect x="387" y="167" width="26" height="58" rx="13" fill="#fff0cf" opacity={pose.litOpacity} />
            <ellipse cx="394" cy="181" rx="3" ry="7" fill="#fff" opacity=".6" />
            <rect x="383" y="162" width="34" height="68" rx="17" fill="none" stroke="#fff" strokeOpacity=".14" strokeWidth="1.5" />
          </g>
        </g>

        <g>
          <ellipse cx="400" cy="466" rx="94" ry="140" fill={fill(ids.creamV)} />
          <ellipse cx="364" cy="440" rx="26" ry="72" fill="#fff" opacity=".18" filter={fill(ids.blur6)} />
          <path d="M350 376 Q400 396 450 376" fill="none" stroke="#9c7f55" strokeOpacity=".32" strokeWidth="3" strokeLinecap="round" />
          <path d="M352 382 Q400 402 448 382" fill="none" stroke="#fff" strokeOpacity=".5" strokeWidth="2" strokeLinecap="round" />
        </g>

        {/* Right arm: scale is 1, so the rig is only rotated. */}
        <g transform="translate(512 398)">
          <g transform={`rotate(${pose.rightArm.shoulder})`}>
            <g transform={`translate(0 78) rotate(${pose.rightArm.elbow})`}>
              <rect x="-19" y="-19" width="38" height="120" rx="19" fill={fill(ids.limb)} />
              <ellipse cx="0" cy="82" rx="22" ry="24" fill={fill(ids.limb)} />
            </g>
            <rect x="-21" y="-21" width="42" height="120" rx="21" fill={fill(ids.limb)} />
          </g>
        </g>

        {/* Left arm: mirrored with scale(-1 1), matching the reference rig. */}
        <g transform="translate(288 398) scale(-1 1)">
          <g transform={`rotate(${pose.leftArm.shoulder})`}>
            <g transform={`translate(0 78) rotate(${pose.leftArm.elbow})`}>
              <rect x="-19" y="-19" width="38" height="120" rx="19" fill={fill(ids.limbR)} />
              <ellipse cx="0" cy="82" rx="22" ry="24" fill={fill(ids.limbR)} />
            </g>
            <rect x="-21" y="-21" width="42" height="120" rx="21" fill={fill(ids.limbR)} />
          </g>
        </g>
      </g>
    </svg>
  );

  return (
    <span
      data-testid="mascot-svg"
      data-mascot-state={state}
      data-mascot-reduced={motionReduced ? "true" : "false"}
      data-time={fixed(time, 3)}
      aria-hidden={!onClick && !label ? "true" : undefined}
      className={className}
      style={{ display: "inline-block", lineHeight: 0, background: "transparent" }}
    >
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          aria-label={clickLabel ?? "Wave hello"}
          className="grid place-items-center rounded-2xl transition-transform duration-150 hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70 active:scale-95"
          style={{ lineHeight: 0, background: "transparent" }}
        >
          {art}
        </button>
      ) : (
        art
      )}
      {label ? (
        <span className="sr-only" role="status">
          {label}
        </span>
      ) : null}
    </span>
  );
}

export default MascotSvg;
