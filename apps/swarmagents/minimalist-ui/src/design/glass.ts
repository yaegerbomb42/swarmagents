/**
 * Smoked-crystal neo-glassmorphic material tokens (from Fable 5.2 Extra High).
 * Kept as literal Tailwind class strings so Tailwind v4 scans every utility.
 */

export const GLASS = "bg-zinc-950/60 backdrop-blur-2xl backdrop-saturate-150";

export const RIM = "border border-white/[0.12]";

/** Large floating surfaces: composer, stage, settings sheet. */
export const LIFT_LG = "shadow-[inset_0_1px_0_0_rgba(255,255,255,0.15),0_24px_60px_rgba(0,0,0,0.65)]";

/** Compact floating surfaces: pills, badges, chips. */
export const LIFT_SM = "shadow-[inset_0_1px_0_0_rgba(255,255,255,0.15),0_12px_32px_rgba(0,0,0,0.5)]";

/** Soft specular light falling across the top-left edge of a glass surface. */
export const SPECULAR =
  "pointer-events-none absolute inset-0 rounded-[inherit] bg-[radial-gradient(110%_120%_at_14%_-30%,rgba(255,255,255,0.10),transparent_58%)]";

/** Viewport-wide inset hairline glow when the user is driving the live VM desktop. */
export const TAKEOVER_HAIRLINE =
  "pointer-events-none fixed inset-0 z-[35] shadow-[inset_0_0_0_1.5px_rgba(0,208,240,0.45),inset_0_0_80px_rgba(0,208,240,0.08)] transition-opacity duration-500";
