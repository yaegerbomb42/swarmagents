// Physics material constants — tuned for realism, not arcade.
// All masses in kg, dimensions in m.
//
// Rapier conventions (we use them throughout):
//   friction:    0  = ice;       1  = rubber
//   restitution: 0  = clay;      1  = perfect bounce
//   density (kg/m^3) — we set explicit colliderDensity per object so
//   mass = density * volume. Defaults: human ~1000, wood ~600, glass 2500.

export const MATERIALS = {
  agent_body:  { density: 1000, friction: 0.55, restitution: 0.05, linearDamping: 0.6,  angularDamping: 0.9  },
  agent_head:  { density: 1000, friction: 0.45, restitution: 0.05, linearDamping: 0.6,  angularDamping: 0.9  },
  agent_hand:  { density: 1000, friction: 0.8,  restitution: 0.1,  linearDamping: 0.5,  angularDamping: 0.7  },
  floor:       { density: 2000, friction: 0.85, restitution: 0.0,  linearDamping: 0.0,  angularDamping: 0.0  },
  glass_wall:  { density: 2500, friction: 0.30, restitution: 0.05, linearDamping: 0.4,  angularDamping: 0.7  },
  glass_shard: { density: 2500, friction: 0.30, restitution: 0.05, linearDamping: 0.7,  angularDamping: 0.9  },
  couch:       { density: 250,  friction: 0.65, restitution: 0.05, linearDamping: 0.6,  angularDamping: 0.85 },
  table:       { density: 600,  friction: 0.55, restitution: 0.1,  linearDamping: 0.4,  angularDamping: 0.8  },
  tv:          { density: 800,  friction: 0.55, restitution: 0.0,  linearDamping: 0.4,  angularDamping: 0.9  },
  plant:       { density: 350,  friction: 0.55, restitution: 0.1,  linearDamping: 0.5,  angularDamping: 0.85 },
  cup:         { density: 1300, friction: 0.40, restitution: 0.35, linearDamping: 0.3,  angularDamping: 0.4  },
  ball:        { density: 1100, friction: 0.55, restitution: 0.78, linearDamping: 0.2,  angularDamping: 0.25 },
  drone:       { density: 350,  friction: 0.45, restitution: 0.2,  linearDamping: 0.5,  angularDamping: 0.7  },
} as const;

export type MaterialKey = keyof typeof MATERIALS;

// Glass break threshold — kinetic energy (1/2 * m * v^2) in joules.
// A 0.5 kg ball at 8 m/s has KE = 16 J. A 0.2 kg cup at 5 m/s has KE = 2.5 J.
// Set so the ball reliably breaks glass, the cup mostly doesn't.
export const GLASS_BREAK_KE_THRESHOLD = 10;

// How many shards a broken wall splits into.
export const GLASS_SHARD_COUNT = 14;

// Standard size of a room wall section, used for placement.
export const ROOM = {
  width:  10, // m  (x)
  depth:  6,  // m  (z)
  height: 3,  // m  (y)
  wallThickness: 0.05,
} as const;

// Time/physics tunables
export const TICK = {
  brainHz: 1.2,             // 1.2 decisions per second per agent
  maxSpeed: 2.8,            // m/s when walking
  acceleration: 8,          // m/s^2
  turnRate: 4.0,            // rad/s
  jumpImpulse: 280,         // newton·seconds
  pickupRange: 1.1,         // m
  throwSpeed: 9,            // m/s
} as const;
