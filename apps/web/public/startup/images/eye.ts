export const eyeVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vViewDir = cameraPosition - worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

export const eyeFragment = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewDir;

  uniform float uTime;
  uniform float uPupil;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 4; i++) {
      v += amp * noise(p);
      p *= 2.0;
      amp *= 0.55;
    }
    return v;
  }

  void main() {
    vec2 uv = vUv * 2.0 - 1.0;
    float r = length(uv);
    float pupilRadius = mix(0.18, 0.45, clamp(uPupil, 0.1, 0.95));

    float irisMask = smoothstep(pupilRadius + 0.01, pupilRadius + 0.08, r);
    float irisDetail = fbm(uv * 12.0 + uTime * 0.4);
    vec3 iris = mix(vec3(0.05, 0.12, 0.16), vec3(0.15, 0.52, 0.72), irisDetail);
    iris += vec3(0.05, 0.18, 0.3) * irisDetail * irisMask;

    float pupil = smoothstep(pupilRadius, pupilRadius - 0.03, r);
    vec3 sclera = mix(vec3(0.95, 0.98, 1.0), vec3(0.82, 0.92, 1.0), r * 0.4);

    vec3 color = mix(sclera, iris, irisMask);
    color = mix(color, vec3(0.02, 0.04, 0.05), pupil);

    vec3 N = normalize(vNormal);
    vec3 V = normalize(vViewDir);
    vec3 L = normalize(vec3(0.6, 0.5, 0.2));
    vec3 H = normalize(L + V);
    float spec = pow(max(dot(N, H), 0.0), 48.0) * 0.8;
    float wet = pow(1.0 - max(dot(N, V), 0.0), 2.6) * 0.35;

    color += (spec + wet) * vec3(1.0);
    gl_FragColor = vec4(color, 1.0);
  }
`;
