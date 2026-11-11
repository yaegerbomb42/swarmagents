import * as THREE from "three";

export type ParticlePhase = "stream" | "orbit" | "funnel";

export interface Particle {
  id: number;
  char: string;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  phase: ParticlePhase;
  age: number;
  orbitAngle: number;
  orbitRadius: number;
  targetLimb: number;
  size: number;
  opacity: number;
}

export interface LimbState {
  anchorAngle: number;
  anchorRadius: number;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  pulse: number;
  swell: number;
}

export interface Snapshot {
  bodyPosition: THREE.Vector3;
  bodyScale: number;
  limbs: LimbState[];
  eyePosition: THREE.Vector3;
  lookTarget: THREE.Vector3;
  pupil: number;
  ingestionActive: boolean;
  lookDir: THREE.Vector3;
}

const MAX_PARTICLES = 160;

function hashText(input: string, limbCount: number): number {
  let hash = 17;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) % 8191;
  }
  return Math.abs(hash) % limbCount;
}

function noiseVec(p: THREE.Vector3, t: number): THREE.Vector3 {
  const nx = Math.sin(p.y * 2.1 + t * 1.7 + p.x * 0.5);
  const ny = Math.sin(p.z * 2.7 - t * 1.1 + p.y * 0.4);
  const nz = Math.sin(p.x * 2.3 + t * 1.3 + p.z * 0.7);
  return new THREE.Vector3(nx, ny, nz);
}

function bezier3(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, t: number, target: THREE.Vector3) {
  const ab = a.clone().lerp(b, t);
  const bc = b.clone().lerp(c, t);
  target.copy(ab.lerp(bc, t));
}

export class CreatureController {
  private readonly limbs: LimbState[];
  private particles: Particle[] = [];
  private particleStamp = 0;

  private bodyPos = new THREE.Vector3(0, 0, 0);
  private bodyVel = new THREE.Vector3();
  private roamTarget = new THREE.Vector3(0, 0, 0);
  private bodyScale = 1;
  private lookTarget = new THREE.Vector3();
  private lookDir = new THREE.Vector3(0, 0, -1);
  private eyePos = new THREE.Vector3(0, 0.12, 0.5);
  private readonly eyeOffset = new THREE.Vector3(0, 0.12, 0.5);

  private ingestionActive = false;
  private pupil = 0.3;
  private needsSync = false;

  private saccade = new THREE.Vector2();
  private nextSaccade = 0.3;

  private pointer = new THREE.Vector2();
  private readonly tmpVec3 = new THREE.Vector3();

  constructor(limbCount = 5) {
    this.limbs = new Array(limbCount).fill(null).map((_, i) => {
      const angle = (i / limbCount) * Math.PI * 2;
      return {
        anchorAngle: angle,
        anchorRadius: 1.15,
        position: new THREE.Vector3(Math.cos(angle) * 1.15, -0.2, Math.sin(angle) * 1.15),
        velocity: new THREE.Vector3(),
        pulse: 0,
        swell: 1
      };
    });
    this.pickNewRoam();
  }

  setPointer(ndc: THREE.Vector2) {
    this.pointer.copy(ndc);
  }

  ingest(text: string) {
    const limbIndex = hashText(text, this.limbs.length);
    const emitter = new THREE.Vector3(0, -1.4, 0.2);
    const clamped = text.slice(0, MAX_PARTICLES);

    for (let i = 0; i < clamped.length; i += 1) {
      if (this.particles.length >= MAX_PARTICLES) break;
      const jitter = noiseVec(emitter, (i + 1) * 0.12).multiplyScalar(0.12);
      this.particles.push({
        id: ++this.particleStamp,
        char: clamped[i] ?? "",
        position: emitter.clone().add(jitter),
        velocity: new THREE.Vector3(),
        phase: "stream",
        age: 0,
        orbitAngle: Math.random() * Math.PI * 2,
        orbitRadius: 0.35 + Math.random() * 0.12,
        targetLimb: limbIndex,
        size: 0.24,
        opacity: 1
      });
    }
    this.ingestionActive = true;
    this.needsSync = true;
  }

  update(dt: number, time: number): boolean {
    const prevCount = this.particles.length;
    this.bodyUpdate(dt, time);
    this.limbUpdate(dt, time);
    this.particleUpdate(dt, time);
    this.eyeUpdate(dt, time);
    const changed = this.needsSync || prevCount !== this.particles.length;
    this.needsSync = false;
    return changed;
  }

  private pickNewRoam() {
    this.roamTarget.set(
      THREE.MathUtils.randFloatSpread(1.2),
      THREE.MathUtils.randFloatSpread(0.6),
      THREE.MathUtils.randFloat(0.2, 0.6)
    );
  }

  private bodyUpdate(dt: number, time: number) {
    if (time % 7 < 0.02) {
      this.pickNewRoam();
    }
    const toTarget = this.tmpVec3.copy(this.roamTarget).sub(this.bodyPos);
    this.bodyVel.addScaledVector(toTarget, dt * 0.6);
    this.bodyVel.multiplyScalar(0.96);
    this.bodyPos.addScaledVector(this.bodyVel, dt);

    const breathe = 0.08 * Math.sin(time * 1.2) + 0.025 * Math.sin(time * 2.4);
    this.bodyScale = 1 + breathe;
    this.eyePos.copy(this.bodyPos).add(this.eyeOffset);
  }

  private limbUpdate(dt: number, time: number) {
    for (let i = 0; i < this.limbs.length; i += 1) {
      const limb = this.limbs[i];
      const anchor = this.tmpVec3
        .set(Math.cos(limb.anchorAngle), 0, Math.sin(limb.anchorAngle))
        .multiplyScalar(limb.anchorRadius + 0.12 * Math.sin(time * 0.8 + i))
        .add(this.bodyPos);

      const desired = anchor.add(new THREE.Vector3(0, Math.sin(time * 1.5 + i) * 0.12, 0));
      const acc = desired.sub(limb.position).multiplyScalar(1.6);
      limb.velocity.addScaledVector(acc, dt);
      limb.velocity.multiplyScalar(0.86);
      limb.position.addScaledVector(limb.velocity, dt);

      limb.pulse = Math.max(0, limb.pulse - dt * 1.05);
      limb.swell = 1 + limb.pulse * 0.55;
    }
  }

  private particleUpdate(dt: number, time: number) {
    const removal: number[] = [];
    const eye = this.eyePos;
    this.ingestionActive = this.particles.length > 0;

    for (let i = 0; i < this.particles.length; i += 1) {
      const p = this.particles[i];
      p.age += dt;

      if (p.phase === "stream") {
        const target = this.tmpVec3.copy(this.bodyPos).addScaledVector(noiseVec(p.position, time), 0.35);
        const toTarget = target.sub(p.position);
        const curl = noiseVec(p.position, time * 0.7).multiplyScalar(0.55);
        p.velocity.addScaledVector(toTarget, dt * 1.2);
        p.velocity.addScaledVector(curl, dt * 0.5);
        p.velocity.multiplyScalar(0.93);
        p.position.addScaledVector(p.velocity, dt);

        if (toTarget.length() < 0.28 || p.age > 1.35) {
          p.phase = "orbit";
          p.age = 0;
        }
      } else if (p.phase === "orbit") {
        p.orbitAngle += dt * (4.8 + Math.sin(time + p.id) * 0.8);
        const r = p.orbitRadius;
        const y = Math.sin(p.orbitAngle * 0.9) * 0.12;
        p.position.set(
          eye.x + Math.cos(p.orbitAngle) * r,
          eye.y + y,
          eye.z + Math.sin(p.orbitAngle) * r
        );
        p.opacity = 1;
        p.size = 0.23;
        if (p.age > 1.15) {
          p.phase = "funnel";
          p.age = 0;
        }
      } else {
        const limb = this.limbs[p.targetLimb % this.limbs.length];
        const t = Math.min(1, p.age / 0.9);
        const mid = this.tmpVec3.copy(eye).lerp(limb.position, 0.35);
        mid.y += Math.sin(t * Math.PI) * 0.18;
        bezier3(eye, mid, limb.position, t, p.position);
        p.opacity = 1 - t * 0.7;
        p.size = 0.23 + (1 - t) * 0.12;

        if (t >= 1 || p.position.distanceTo(limb.position) < 0.07) {
          limb.pulse = 1;
          removal.push(i);
        }
      }
    }

    for (let i = removal.length - 1; i >= 0; i -= 1) {
      const index = removal[i];
      if (index === undefined) continue;
      this.particles.splice(index, 1);
    }
  }

  private eyeUpdate(dt: number, time: number) {
    const ingestionFocus = this.ingestionActive ? this.activeParticleCentroid() : null;
    const pointerTarget = this.tmpVec3
      .set(this.pointer.x * 1.2, this.pointer.y * 0.8, 1.5)
      .add(this.bodyPos.clone().multiplyScalar(0.1));

    this.saccade.multiplyScalar(Math.exp(-dt * 8));
    if (time > this.nextSaccade) {
      this.saccade.set(
        THREE.MathUtils.randFloatSpread(0.08),
        THREE.MathUtils.randFloatSpread(0.08)
      );
      this.nextSaccade = time + THREE.MathUtils.randFloat(0.6, 1.4);
    }

    const target = ingestionFocus ?? pointerTarget;
    target.x += this.saccade.x;
    target.y += this.saccade.y;
    target.z = Math.max(target.z, 0.5);

    this.lookTarget.lerp(target, 0.12);
    this.lookDir.copy(this.lookTarget).sub(this.eyePos).normalize();

    const desiredPupil = 0.32 + Math.min(0.28, this.particles.length * 0.004);
    this.pupil = THREE.MathUtils.damp(this.pupil, desiredPupil, 6, dt);
  }

  private activeParticleCentroid(): THREE.Vector3 | null {
    if (!this.ingestionActive) return null;
    let count = 0;
    this.tmpVec3.set(0, 0, 0);
    for (const p of this.particles) {
      if (p.phase === "funnel" || p.phase === "orbit" || p.phase === "stream") {
        this.tmpVec3.add(p.position);
        count += 1;
      }
    }
    if (count === 0) return null;
    return this.tmpVec3.multiplyScalar(1 / count);
  }

  get snapshot(): Snapshot {
    return {
      bodyPosition: this.bodyPos,
      bodyScale: this.bodyScale,
      limbs: this.limbs,
      eyePosition: this.eyePos,
      lookTarget: this.lookTarget,
      pupil: this.pupil,
      ingestionActive: this.ingestionActive,
      lookDir: this.lookDir
    };
  }

  getParticles(): Particle[] {
    return this.particles;
  }

  getParticle(id: number): Particle | undefined {
    return this.particles.find((p) => p.id === id);
  }
}
