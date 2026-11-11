'use client';

import React from 'react';

interface IconProps {
  size?: number;
  className?: string;
}

/** Hamiltonian Router — orbital field lines radiating from a central core */
export function HamiltonianRouterIcon({ size = 48, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" className={className}>
      <defs>
        <linearGradient id="hr-grad" x1="0" y1="0" x2="64" y2="64">
          <stop offset="0%" stopColor="#00BFFF" />
          <stop offset="100%" stopColor="#8A2BE2" />
        </linearGradient>
        <radialGradient id="hr-core" cx="50%" cy="50%" r="25%">
          <stop offset="0%" stopColor="#F0F8FF" />
          <stop offset="100%" stopColor="#00BFFF" />
        </radialGradient>
      </defs>
      {/* Orbital rings */}
      <ellipse cx="32" cy="32" rx="28" ry="12" stroke="url(#hr-grad)" strokeWidth="1.2" opacity="0.6" transform="rotate(-30 32 32)" />
      <ellipse cx="32" cy="32" rx="28" ry="12" stroke="url(#hr-grad)" strokeWidth="1.2" opacity="0.6" transform="rotate(30 32 32)" />
      <ellipse cx="32" cy="32" rx="28" ry="12" stroke="url(#hr-grad)" strokeWidth="1.2" opacity="0.6" transform="rotate(90 32 32)" />
      {/* Field lines */}
      <path d="M32 32 C20 14, 8 20, 6 32" stroke="#00BFFF" strokeWidth="0.8" opacity="0.5" fill="none" />
      <path d="M32 32 C44 14, 56 20, 58 32" stroke="#8A2BE2" strokeWidth="0.8" opacity="0.5" fill="none" />
      <path d="M32 32 C20 50, 8 44, 6 32" stroke="#8A2BE2" strokeWidth="0.8" opacity="0.5" fill="none" />
      <path d="M32 32 C44 50, 56 44, 58 32" stroke="#00BFFF" strokeWidth="0.8" opacity="0.5" fill="none" />
      {/* Orbital dots */}
      <circle cx="14" cy="18" r="2.5" fill="#00BFFF" opacity="0.9" />
      <circle cx="50" cy="18" r="2.5" fill="#7DD3FC" opacity="0.9" />
      <circle cx="14" cy="46" r="2.5" fill="#8A2BE2" opacity="0.9" />
      <circle cx="50" cy="46" r="2.5" fill="#A78BFA" opacity="0.9" />
      <circle cx="32" cy="6" r="2" fill="#00BFFF" opacity="0.8" />
      <circle cx="32" cy="58" r="2" fill="#8A2BE2" opacity="0.8" />
      {/* Central core */}
      <circle cx="32" cy="32" r="6" fill="url(#hr-core)" />
      <circle cx="32" cy="32" r="8" stroke="#00BFFF" strokeWidth="0.8" opacity="0.4" fill="none" />
    </svg>
  );
}

/** Latent Space — hypercube / geometric lattice network */
export function LatentSpaceIcon({ size = 48, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" className={className}>
      <defs>
        <linearGradient id="ls-grad" x1="0" y1="0" x2="64" y2="64">
          <stop offset="0%" stopColor="#00BFFF" />
          <stop offset="100%" stopColor="#8A2BE2" />
        </linearGradient>
      </defs>
      {/* Outer hexagonal frame */}
      <polygon points="32,4 56,18 56,46 32,60 8,46 8,18" stroke="url(#ls-grad)" strokeWidth="1.2" fill="none" opacity="0.6" />
      {/* Inner structure — cross connections */}
      <line x1="32" y1="4" x2="32" y2="60" stroke="#00BFFF" strokeWidth="0.6" opacity="0.3" />
      <line x1="8" y1="18" x2="56" y2="46" stroke="#00BFFF" strokeWidth="0.6" opacity="0.3" />
      <line x1="56" y1="18" x2="8" y2="46" stroke="#8A2BE2" strokeWidth="0.6" opacity="0.3" />
      <line x1="8" y1="18" x2="56" y2="18" stroke="#7DD3FC" strokeWidth="0.6" opacity="0.3" />
      <line x1="8" y1="46" x2="56" y2="46" stroke="#A78BFA" strokeWidth="0.6" opacity="0.3" />
      {/* Diagonal lattice */}
      <line x1="32" y1="4" x2="8" y2="46" stroke="#00BFFF" strokeWidth="0.5" opacity="0.25" />
      <line x1="32" y1="4" x2="56" y2="46" stroke="#8A2BE2" strokeWidth="0.5" opacity="0.25" />
      <line x1="32" y1="60" x2="8" y2="18" stroke="#8A2BE2" strokeWidth="0.5" opacity="0.25" />
      <line x1="32" y1="60" x2="56" y2="18" stroke="#00BFFF" strokeWidth="0.5" opacity="0.25" />
      {/* Inner diamond */}
      <polygon points="32,18 44,32 32,46 20,32" stroke="url(#ls-grad)" strokeWidth="1" fill="none" opacity="0.5" />
      {/* Vertex nodes */}
      <circle cx="32" cy="4" r="3" fill="#00BFFF" />
      <circle cx="56" cy="18" r="3" fill="#38BDF8" />
      <circle cx="56" cy="46" r="3" fill="#818CF8" />
      <circle cx="32" cy="60" r="3" fill="#8A2BE2" />
      <circle cx="8" cy="46" r="3" fill="#A78BFA" />
      <circle cx="8" cy="18" r="3" fill="#7DD3FC" />
      {/* Inner nodes */}
      <circle cx="32" cy="18" r="2.5" fill="#00BFFF" opacity="0.8" />
      <circle cx="44" cy="32" r="2.5" fill="#38BDF8" opacity="0.8" />
      <circle cx="32" cy="46" r="2.5" fill="#8A2BE2" opacity="0.8" />
      <circle cx="20" cy="32" r="2.5" fill="#A78BFA" opacity="0.8" />
      <circle cx="32" cy="32" r="2" fill="#F0F8FF" opacity="0.9" />
    </svg>
  );
}

/** MoE / Swarm Core — brain shape with circuit paths and bidirectional arrows */
export function SwarmCoreIcon({ size = 48, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" className={className}>
      <defs>
        <linearGradient id="sc-grad" x1="0" y1="0" x2="64" y2="64">
          <stop offset="0%" stopColor="#00BFFF" />
          <stop offset="100%" stopColor="#8A2BE2" />
        </linearGradient>
      </defs>
      {/* Brain outline */}
      <path d="M32 8 C18 8, 8 18, 10 30 C8 36, 12 44, 18 48 C20 52, 26 56, 32 56 C38 56, 44 52, 46 48 C52 44, 56 36, 54 30 C56 18, 46 8, 32 8Z"
        stroke="url(#sc-grad)" strokeWidth="1.5" fill="none" opacity="0.5" />
      {/* Central spine */}
      <line x1="32" y1="14" x2="32" y2="50" stroke="#00BFFF" strokeWidth="1.5" opacity="0.4" />
      <line x1="30" y1="14" x2="30" y2="50" stroke="#8A2BE2" strokeWidth="1" opacity="0.3" />
      <line x1="34" y1="14" x2="34" y2="50" stroke="#8A2BE2" strokeWidth="1" opacity="0.3" />
      {/* Circuit paths */}
      <path d="M20 20 C24 18, 28 22, 32 20" stroke="#00BFFF" strokeWidth="0.8" fill="none" opacity="0.6" />
      <path d="M32 20 C36 18, 40 22, 44 20" stroke="#8A2BE2" strokeWidth="0.8" fill="none" opacity="0.6" />
      <path d="M18 30 C22 28, 26 32, 32 30" stroke="#7DD3FC" strokeWidth="0.8" fill="none" opacity="0.6" />
      <path d="M32 30 C38 28, 42 32, 46 30" stroke="#A78BFA" strokeWidth="0.8" fill="none" opacity="0.6" />
      <path d="M20 40 C24 38, 28 42, 32 40" stroke="#00BFFF" strokeWidth="0.8" fill="none" opacity="0.6" />
      <path d="M32 40 C36 38, 40 42, 44 40" stroke="#8A2BE2" strokeWidth="0.8" fill="none" opacity="0.6" />
      {/* Nodes */}
      <circle cx="20" cy="20" r="2.5" fill="#00BFFF" opacity="0.9" />
      <circle cx="44" cy="20" r="2.5" fill="#8A2BE2" opacity="0.9" />
      <circle cx="18" cy="30" r="2.5" fill="#7DD3FC" opacity="0.9" />
      <circle cx="46" cy="30" r="2.5" fill="#A78BFA" opacity="0.9" />
      <circle cx="20" cy="40" r="2.5" fill="#00BFFF" opacity="0.9" />
      <circle cx="44" cy="40" r="2.5" fill="#8A2BE2" opacity="0.9" />
      <circle cx="32" cy="20" r="2" fill="#F0F8FF" />
      <circle cx="32" cy="30" r="2" fill="#F0F8FF" />
      <circle cx="32" cy="40" r="2" fill="#F0F8FF" />
      {/* Directional arrows (outgoing signals) */}
      <path d="M14 16 L10 14 L12 18" stroke="#00BFFF" strokeWidth="1" fill="none" opacity="0.7" />
      <path d="M50 16 L54 14 L52 18" stroke="#8A2BE2" strokeWidth="1" fill="none" opacity="0.7" />
      <circle cx="10" cy="14" r="1.5" fill="#00BFFF" opacity="0.6" />
      <circle cx="54" cy="14" r="1.5" fill="#8A2BE2" opacity="0.6" />
    </svg>
  );
}

/** Genesis Protocol — fan-out from single bright core to many nodes */
export function GenesisProtocolIcon({ size = 48, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" className={className}>
      <defs>
        <radialGradient id="gp-core" cx="25%" cy="50%" r="20%">
          <stop offset="0%" stopColor="#F0F8FF" />
          <stop offset="100%" stopColor="#00BFFF" />
        </radialGradient>
        <linearGradient id="gp-line" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#00BFFF" />
          <stop offset="100%" stopColor="#8A2BE2" />
        </linearGradient>
      </defs>
      {/* Core glow ring */}
      <circle cx="14" cy="32" r="8" stroke="#00BFFF" strokeWidth="0.8" opacity="0.3" fill="none" />
      <circle cx="14" cy="32" r="5" fill="url(#gp-core)" />
      {/* Fan-out lines */}
      <line x1="19" y1="32" x2="38" y2="10" stroke="url(#gp-line)" strokeWidth="1" opacity="0.6" />
      <line x1="19" y1="32" x2="42" y2="16" stroke="url(#gp-line)" strokeWidth="1" opacity="0.6" />
      <line x1="19" y1="32" x2="44" y2="22" stroke="url(#gp-line)" strokeWidth="1" opacity="0.6" />
      <line x1="19" y1="32" x2="46" y2="28" stroke="url(#gp-line)" strokeWidth="1" opacity="0.6" />
      <line x1="19" y1="32" x2="46" y2="36" stroke="url(#gp-line)" strokeWidth="1" opacity="0.6" />
      <line x1="19" y1="32" x2="44" y2="42" stroke="url(#gp-line)" strokeWidth="1" opacity="0.6" />
      <line x1="19" y1="32" x2="42" y2="48" stroke="url(#gp-line)" strokeWidth="1" opacity="0.6" />
      <line x1="19" y1="32" x2="38" y2="54" stroke="url(#gp-line)" strokeWidth="1" opacity="0.6" />
      {/* Endpoint nodes — gradient from cyan to purple */}
      <circle cx="38" cy="10" r="3" fill="#00BFFF" />
      <circle cx="42" cy="16" r="3" fill="#22D3EE" />
      <circle cx="44" cy="22" r="3" fill="#38BDF8" />
      <circle cx="46" cy="28" r="3" fill="#7DD3FC" />
      <circle cx="46" cy="36" r="3" fill="#818CF8" />
      <circle cx="44" cy="42" r="3" fill="#A78BFA" />
      <circle cx="42" cy="48" r="3" fill="#8A2BE2" />
      <circle cx="38" cy="54" r="3" fill="#7C3AED" />
      {/* Secondary connections between endpoint nodes */}
      <path d="M38 10 Q52 14, 42 16" stroke="#00BFFF" strokeWidth="0.5" fill="none" opacity="0.3" />
      <path d="M44 22 Q50 25, 46 28" stroke="#38BDF8" strokeWidth="0.5" fill="none" opacity="0.3" />
      <path d="M46 36 Q50 39, 44 42" stroke="#A78BFA" strokeWidth="0.5" fill="none" opacity="0.3" />
      <path d="M42 48 Q46 52, 38 54" stroke="#8A2BE2" strokeWidth="0.5" fill="none" opacity="0.3" />
    </svg>
  );
}
