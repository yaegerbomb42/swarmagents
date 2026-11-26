export interface Fingerprint {
  hash: string;
  windowId: string;
  windowTitle: string;
}
export interface Point { x: number; y: number }
export interface CaptureOpts { point?: Point | null; regionSize?: { w: number; h: number } }
export interface SettleResult {
  changed: boolean;
  before: Fingerprint | null;
  after: Fingerprint | null;
  elapsedMs: number;
}
export const EFFECT_HINT: string;
export function effectEnabled(): boolean;
export function setCaptureRunnerForTesting(
  runner: ((opts: CaptureOpts) => Promise<Partial<Fingerprint> | null> | Partial<Fingerprint> | null) | null,
): void;
export function captureFingerprint(opts?: CaptureOpts): Promise<Fingerprint | null>;
export function regionGeometry(point: Point | null | undefined, size?: { w: number; h: number }): string | null;
export function fingerprintsDiffer(before: Partial<Fingerprint> | null | undefined, after: Partial<Fingerprint> | null | undefined): boolean;
export function settle(
  before: Partial<Fingerprint> | null,
  capture: () => Promise<Partial<Fingerprint> | null> | Partial<Fingerprint> | null,
  opts?: { timeoutMs?: number; intervalMs?: number; initialMs?: number },
): Promise<SettleResult>;
export class HintCounter {
  constructor(threshold?: number);
  threshold: number;
  streak: number;
  record(changed: boolean): string | null;
}
export function noteEffectResult(changed: boolean): string | null;
export function resetEffectCounter(): void;
export function effectPoint(args: unknown, tool: string): Point | null;
export function formatEffectLine(res: SettleResult | null | undefined, point?: Point | null): string;
