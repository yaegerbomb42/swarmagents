export const bodyVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const bodyFragment = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  varying vec3 vWorld;

  uniform float uTime;
  uniform vec2 uResolution;
  uniform sampler2D uRefraction;
  uniform vec3 uBodyPos;
  uniform vec3 uEyePos;
  uniform float uBodyScale;
  uniform vec3 uLimbCenters[8];
  uniform float uLimbPulse[8];
  uniform int uLimbCount;
  uniform mat4 uInvProjection;
  uniform mat4 uInvView;

  float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
  }

  float noise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    float n = dot(i, vec3(1.0, 57.0, 113.0));
    float res = mix(
      mix(mix(hash11(n + 0.0), hash11(n + 1.0), f.x), mix(hash11(n + 57.0), hash11(n + 58.0), f.x), f.y),
      mix(mix(hash11(n + 113.0), hash11(n + 114.0), f.x), mix(hash11(n + 170.0), hash11(n + 171.0), f.x), f.y),
      f.z
    );
    return res;
  }

  float fbm(vec3 p) {
    float sum = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 5; i++) {
      sum += amp * noise(p);
      p *= 2.07;
      amp *= 0.55;
    }
    return sum;
  }

  float sdSphere(vec3 p, float r) {
    return length(p) - r;
  }

  float map(vec3 p) {
    vec3 q = p - uBodyPos;
    float wobble = fbm(q * 1.2 + uTime * 0.35);
    float d = sdSphere(q, 0.96 * uBodyScale) + wobble * 0.18;
    for (int i = 0; i < 8; i++) {
      if (i >= uLimbCount) break;
      vec3 lp = uLimbCenters[i];
      float limb = sdSphere(p - lp, 0.35 + uLimbPulse[i] * 0.2);
      d = min(d, limb);
    }
    return d;
  }

  vec3 calcNormal(vec3 p) {
    const float h = 0.0008;
    vec2 e = vec2(1.0, -1.0) * h;
    return normalize(e.xyy * map(p + e.xyy) + e.yyx * map(p + e.yyx) + e.yxy * map(p + e.yxy) + e.xxx * map(p + e.xxx));
  }

  vec3 getRayDir(vec2 ndc) {
    vec4 clip = vec4(ndc, 0.0, 1.0);
    vec4 view = uInvProjection * clip;
    view /= view.w;
    vec4 world = uInvView * vec4(view.xyz, 0.0);
    return normalize(world.xyz);
  }

  vec3 refractSample(vec2 uv, vec3 n) {
    vec2 offset = n.xy * 0.08;
    offset += (fbm(vec3(n.xy * 2.3, uTime * 0.4)) - 0.5) * 0.04;
    uv = clamp(uv + offset, 0.02, 0.98);
    return texture2D(uRefraction, uv).rgb;
  }

  vec3 shade(vec3 pos, vec3 rd, vec3 normal, float steps) {
    vec2 uv = gl_FragCoord.xy / uResolution;
    float fres = pow(1.0 - max(dot(normal, -rd), 0.0), 3.4);
    float murkFlow = fbm(pos * 1.8 + uTime * 0.6);
    vec3 refr = refractSample(uv, normal);
    vec3 murk = mix(vec3(0.035, 0.07, 0.12), vec3(0.08, 0.22, 0.36), murkFlow);
    vec3 biolume = vec3(0.12, 0.46, 0.94) * (0.55 + murkFlow * 0.6);
    float eyeGlow = exp(-length(pos - uEyePos) * 1.4);

    float limbPulse = 0.0;
    for (int i = 0; i < 8; i++) {
      if (i >= uLimbCount) break;
      limbPulse += uLimbPulse[i];
    }
    float pulseGlow = clamp(limbPulse, 0.0, 2.5);

    vec3 col = mix(murk, refr, 0.45);
    col += biolume * (0.35 + fres * 0.7);
    col += pulseGlow * vec3(0.05, 0.32, 0.8);
    col += eyeGlow * vec3(0.14, 0.3, 0.6);

    col += fres * vec3(0.3, 0.6, 1.1);
    col = mix(col, vec3(0.08, 0.14, 0.2), smoothstep(0.0, 1.0, steps));
    return col;
  }

  void main() {
    vec2 ndc = vUv * 2.0 - 1.0;
    ndc.y *= -1.0;

    vec3 ro = cameraPosition;
    vec3 rd = getRayDir(ndc);

    float t = 0.0;
    float hit = -1.0;
    vec3 pos = ro;

    for (int i = 0; i < 96; i++) {
      pos = ro + rd * t;
      float d = map(pos);
      if (d < 0.001) { hit = float(i); break; }
      t += d * 0.85;
      if (t > 9.0) break;
    }

    vec3 color;
    if (hit > -0.5) {
      vec3 normal = calcNormal(pos);
      color = shade(pos, rd, normal, hit / 96.0);
    } else {
      color = texture2D(uRefraction, vUv).rgb * 0.9;
    }

    color = pow(color, vec3(1.0 / 1.2));
    gl_FragColor = vec4(color, 1.0);
  }
`;

export const backdropVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export const backdropFragment = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;

  float noise(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453);
  }

  void main() {
    vec2 uv = vUv;
    float grain = noise(uv * 120.0 + uTime) * 0.03;
    float bands = sin((uv.y + uTime * 0.02) * 8.0) * 0.05;
    vec3 base = mix(vec3(0.03, 0.05, 0.1), vec3(0.05, 0.12, 0.2), uv.y + bands);
    base += grain;
    gl_FragColor = vec4(base, 1.0);
  }
`;
