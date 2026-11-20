import { AGLValue, ExecutionContext } from './context.ts';

export type KernelFn = (args: AGLValue[], ctx: ExecutionContext) => Promise<AGLValue> | AGLValue;

export const L0_PRIMITIVES: Record<string, KernelFn> = {
  // --- CORE ARITHMETIC ---
  add: (args) => args.reduce<number>((acc, v) => acc + Number(v), 0),
  sub: (args) => {
    if (args.length === 0) return 0;
    if (args.length === 1) return -Number(args[0]);
    return Number(args[0]) - args.slice(1).reduce<number>((acc, v) => acc + Number(v), 0);
  },
  mul: (args) => args.reduce<number>((acc, v) => acc * Number(v), 1),
  div: (args) => {
    if (args.length < 2) return Number(args[0] || 0);
    const denom = Number(args[1]);
    if (denom === 0) throw new Error('Division by zero in lvl:0:div');
    return Number(args[0]) / denom;
  },
  mod: (args) => {
    const a = Number(args[0] || 0);
    const b = Number(args[1] || 1);
    if (b === 0) throw new Error('Modulo by zero in lvl:0:mod');
    return a % b;
  },

  // --- MATHEMATICAL FUNCTIONS (VOXEL & PHYSICS ESSENTIALS) ---
  floor: (args) => Math.floor(Number(args[0] || 0)),
  ceil: (args) => Math.ceil(Number(args[0] || 0)),
  round: (args) => Math.round(Number(args[0] || 0)),
  abs: (args) => Math.abs(Number(args[0] || 0)),
  sqrt: (args) => Math.sqrt(Math.max(0, Number(args[0] || 0))),
  pow: (args) => Math.pow(Number(args[0] || 0), Number(args[1] || 1)),
  min: (args) => Math.min(Number(args[0] || 0), Number(args[1] || 0)),
  max: (args) => Math.max(Number(args[0] || 0), Number(args[1] || 0)),

  // --- TRIGONOMETRY (CAMERA, ROTATION & ANGLES) ---
  sin: (args) => Math.sin(Number(args[0] || 0)),
  cos: (args) => Math.cos(Number(args[0] || 0)),
  tan: (args) => Math.tan(Number(args[0] || 0)),
  atan2: (args) => Math.atan2(Number(args[0] || 0), Number(args[1] || 1)),

  // --- RANDOMNESS & PSEUDO-RANDOM NOISE SEEDING ---
  random: (args) => {
    // If no args: return float [0, 1)
    if (args.length === 0) return Math.random();
    // If 1 arg N: return integer [0, N)
    if (args.length === 1) return Math.floor(Math.random() * Number(args[0]));
    // If 2 args (min, max): return integer [min, max]
    const min = Number(args[0]);
    const max = Number(args[1]);
    return Math.floor(Math.random() * (max - min + 1)) + min;
  },

  // --- COMPARISON & LOGIC ---
  eq: (args) => args[0] === args[1],
  gt: (args) => Number(args[0]) > Number(args[1]),
  lt: (args) => Number(args[0]) < Number(args[1]),
  gte: (args) => Number(args[0]) >= Number(args[1]),
  lte: (args) => Number(args[0]) <= Number(args[1]),
  not: (args) => !Boolean(args[0]),

  // --- STRINGS & BYTES ---
  concat: (args) => args.map(a => (a === null || a === undefined ? '' : String(a))).join(''),
  slice: (args) => {
    const target = args[0];
    const start = Number(args[1] || 0);
    const end = args[2] !== undefined ? Number(args[2]) : undefined;
    if (typeof target === 'string' || Array.isArray(target)) {
      return target.slice(start, end);
    }
    return null;
  },

  // --- DATA STRUCTURES (LISTS & MAPS) ---
  list: (args) => [...args],
  len: (args) => {
    const target = args[0];
    if (Array.isArray(target) || typeof target === 'string') return target.length;
    if (target && typeof target === 'object') return Object.keys(target).length;
    return 0;
  },
  at: (args) => {
    const coll = args[0];
    const idx = args[1];
    if (Array.isArray(coll)) {
      const i = Number(idx);
      return coll[i < 0 ? coll.length + i : i] ?? null;
    }
    if (coll && typeof coll === 'object') {
      return (coll as Record<string, any>)[String(idx)] ?? null;
    }
    return null;
  },
  cons: (args) => {
    const head = args[0];
    const tail = Array.isArray(args[1]) ? args[1] : [];
    return [head, ...tail];
  },
  head: (args) => {
    const list = args[0];
    return Array.isArray(list) && list.length > 0 ? list[0] : null;
  },
  tail: (args) => {
    const list = args[0];
    return Array.isArray(list) && list.length > 0 ? list.slice(1) : [];
  },
  dict: (args) => {
    const obj: Record<string, any> = {};
    for (let i = 0; i < args.length; i += 2) {
      if (i + 1 < args.length) {
        obj[String(args[i])] = args[i + 1];
      }
    }
    return obj;
  },
  dict_set: (args) => {
    const orig = (args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) ? { ...args[0] } : {};
    orig[String(args[1])] = args[2];
    return orig;
  },

  // --- STATE & ENVIRONMENT ---
  get: (args, ctx) => {
    const key = String(args[0]);
    return ctx.get(key);
  },
  set: (args, ctx) => {
    const key = String(args[0]);
    const val = args[1];
    ctx.set(key, val);
    return val;
  },

  // --- CONDITIONALS & CODE BLOCKS ---
  if: (args) => Boolean(args[0]) ? args[1] : args[2],
  block: (args) => args.length > 0 ? args[args.length - 1] : null
};
