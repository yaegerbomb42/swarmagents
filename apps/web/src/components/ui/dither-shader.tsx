'use client';

import React, { useEffect, useRef, useState } from 'react';

// ════════════════════════════════════════════════════════════
//  DitherShader — WebGL fragment shader with Bayer dithering
//  + duotone / monochrome / color modes
//  Renders an image through a retro CRT-style dither pass.
// ════════════════════════════════════════════════════════════

type DitherMode = 'bayer' | 'floyd' | 'random';
type ColorMode = 'duotone' | 'monochrome' | 'color';

interface DitherShaderProps {
  src: string;
  gridSize?: number;
  ditherMode?: DitherMode;
  colorMode?: ColorMode;
  primaryColor?: string;
  secondaryColor?: string;
  threshold?: number;
  className?: string;
  animate?: boolean;
}

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = (a_pos + 1.0) * 0.5;
  v_uv.y = 1.0 - v_uv.y;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG = `
precision highp float;

varying vec2 v_uv;
uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform float u_gridSize;
uniform int u_ditherMode;     // 0=bayer 1=floyd 2=random
uniform int u_colorMode;      // 0=duotone 1=mono 2=color
uniform vec3 u_primary;
uniform vec3 u_secondary;
uniform float u_threshold;
uniform float u_time;

// 8x8 Bayer matrix
float bayer8(vec2 p) {
  int x = int(mod(p.x, 8.0));
  int y = int(mod(p.y, 8.0));
  int idx = y * 8 + x;
  // Hard-coded values 0..63 normalized to 0..1
  if (idx == 0)  return  0.0/64.0;
  if (idx == 1)  return 32.0/64.0;
  if (idx == 2)  return  8.0/64.0;
  if (idx == 3)  return 40.0/64.0;
  if (idx == 4)  return  2.0/64.0;
  if (idx == 5)  return 34.0/64.0;
  if (idx == 6)  return 10.0/64.0;
  if (idx == 7)  return 42.0/64.0;
  if (idx == 8)  return 48.0/64.0;
  if (idx == 9)  return 16.0/64.0;
  if (idx == 10) return 56.0/64.0;
  if (idx == 11) return 24.0/64.0;
  if (idx == 12) return 50.0/64.0;
  if (idx == 13) return 18.0/64.0;
  if (idx == 14) return 58.0/64.0;
  if (idx == 15) return 26.0/64.0;
  if (idx == 16) return 12.0/64.0;
  if (idx == 17) return 44.0/64.0;
  if (idx == 18) return  4.0/64.0;
  if (idx == 19) return 36.0/64.0;
  if (idx == 20) return 14.0/64.0;
  if (idx == 21) return 46.0/64.0;
  if (idx == 22) return  6.0/64.0;
  if (idx == 23) return 38.0/64.0;
  if (idx == 24) return 60.0/64.0;
  if (idx == 25) return 28.0/64.0;
  if (idx == 26) return 52.0/64.0;
  if (idx == 27) return 20.0/64.0;
  if (idx == 28) return 62.0/64.0;
  if (idx == 29) return 30.0/64.0;
  if (idx == 30) return 54.0/64.0;
  if (idx == 31) return 22.0/64.0;
  if (idx == 32) return  3.0/64.0;
  if (idx == 33) return 35.0/64.0;
  if (idx == 34) return 11.0/64.0;
  if (idx == 35) return 43.0/64.0;
  if (idx == 36) return  1.0/64.0;
  if (idx == 37) return 33.0/64.0;
  if (idx == 38) return  9.0/64.0;
  if (idx == 39) return 41.0/64.0;
  if (idx == 40) return 51.0/64.0;
  if (idx == 41) return 19.0/64.0;
  if (idx == 42) return 59.0/64.0;
  if (idx == 43) return 27.0/64.0;
  if (idx == 44) return 49.0/64.0;
  if (idx == 45) return 17.0/64.0;
  if (idx == 46) return 57.0/64.0;
  if (idx == 47) return 25.0/64.0;
  if (idx == 48) return 15.0/64.0;
  if (idx == 49) return 47.0/64.0;
  if (idx == 50) return  7.0/64.0;
  if (idx == 51) return 39.0/64.0;
  if (idx == 52) return 13.0/64.0;
  if (idx == 53) return 45.0/64.0;
  if (idx == 54) return  5.0/64.0;
  if (idx == 55) return 37.0/64.0;
  if (idx == 56) return 63.0/64.0;
  if (idx == 57) return 31.0/64.0;
  if (idx == 58) return 55.0/64.0;
  if (idx == 59) return 23.0/64.0;
  if (idx == 60) return 61.0/64.0;
  if (idx == 61) return 29.0/64.0;
  if (idx == 62) return 53.0/64.0;
  return 21.0/64.0;
}

float random(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

float luma(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

void main() {
  // Snap UV to grid for chunky pixels
  vec2 gridUV = floor(v_uv * u_resolution / u_gridSize) * u_gridSize / u_resolution;
  vec4 tex = texture2D(u_image, gridUV);

  // Pixel position in grid space for dither lookup
  vec2 px = floor(v_uv * u_resolution / u_gridSize);

  float l = luma(tex.rgb);

  float ditherVal;
  if (u_ditherMode == 0) {
    ditherVal = bayer8(px);
  } else if (u_ditherMode == 2) {
    ditherVal = random(px + u_time * 0.1);
  } else {
    // Floyd-like fallback (approx with noise)
    ditherVal = bayer8(px) * 0.5 + random(px) * 0.5;
  }

  // Apply dither: pixel "on" if luma + (dither - threshold) > 0.5
  float thresholded = l + (ditherVal - u_threshold);

  vec3 outColor;
  if (u_colorMode == 0) {
    // Duotone
    float t = step(0.5, thresholded);
    outColor = mix(u_primary, u_secondary, t);
  } else if (u_colorMode == 1) {
    // Monochrome
    float t = step(0.5, thresholded);
    outColor = vec3(t);
  } else {
    // Color: quantize each channel
    vec3 c = tex.rgb;
    outColor = floor(c * 4.0 + (ditherVal - 0.5)) / 3.0;
    outColor = clamp(outColor, 0.0, 1.0);
  }

  gl_FragColor = vec4(outColor, 1.0);
}
`;

function hexToRgb(hex: string): [number, number, number] {
  const cleaned = hex.replace('#', '');
  const r = parseInt(cleaned.slice(0, 2), 16) / 255;
  const g = parseInt(cleaned.slice(2, 4), 16) / 255;
  const b = parseInt(cleaned.slice(4, 6), 16) / 255;
  return [r, g, b];
}

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('Shader compile error:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export function DitherShader({
  src,
  gridSize = 2,
  ditherMode = 'bayer',
  colorMode = 'duotone',
  primaryColor = '#1e3a5f',
  secondaryColor = '#f0e68c',
  threshold = 0.5,
  className = '',
  animate = false,
}: DitherShaderProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [imgLoaded, setImgLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const rafRef = useRef<number | null>(null);

  // Load image
  useEffect(() => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      imgRef.current = img;
      setImgLoaded(true);
    };
    img.onerror = (e) => console.error('Failed to load image', src, e);
    img.src = src;
    return () => {
      imgRef.current = null;
      setImgLoaded(false);
    };
  }, [src]);

  // Render
  useEffect(() => {
    if (!imgLoaded || !canvasRef.current || !imgRef.current) return;
    const canvas = canvasRef.current;
    const img = imgRef.current;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth * dpr;
    const h = canvas.clientHeight * dpr;
    canvas.width = w;
    canvas.height = h;

    const gl = canvas.getContext('webgl', { antialias: false, preserveDrawingBuffer: true });
    if (!gl) {
      console.error('WebGL not supported');
      return;
    }

    const vs = compileShader(gl, gl.VERTEX_SHADER, VERT);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;

    const prog = gl.createProgram();
    if (!prog) return;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(prog));
      return;
    }
    gl.useProgram(prog);

    // Full-screen quad
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );

    const posLoc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    // Texture
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);

    // Uniforms
    const uRes = gl.getUniformLocation(prog, 'u_resolution');
    const uGrid = gl.getUniformLocation(prog, 'u_gridSize');
    const uDM = gl.getUniformLocation(prog, 'u_ditherMode');
    const uCM = gl.getUniformLocation(prog, 'u_colorMode');
    const uP = gl.getUniformLocation(prog, 'u_primary');
    const uS = gl.getUniformLocation(prog, 'u_secondary');
    const uT = gl.getUniformLocation(prog, 'u_threshold');
    const uTime = gl.getUniformLocation(prog, 'u_time');

    const ditherIdx = { bayer: 0, floyd: 1, random: 2 }[ditherMode];
    const colorIdx = { duotone: 0, monochrome: 1, color: 2 }[colorMode];
    const [pr, pg, pb] = hexToRgb(primaryColor);
    const [sr, sg, sb] = hexToRgb(secondaryColor);

    const draw = (time: number) => {
      gl.viewport(0, 0, w, h);
      gl.uniform2f(uRes, w, h);
      gl.uniform1f(uGrid, Math.max(1, gridSize) * dpr);
      gl.uniform1i(uDM, ditherIdx);
      gl.uniform1i(uCM, colorIdx);
      gl.uniform3f(uP, pr, pg, pb);
      gl.uniform3f(uS, sr, sg, sb);
      gl.uniform1f(uT, threshold);
      gl.uniform1f(uTime, time / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (animate) {
        rafRef.current = requestAnimationFrame(draw);
      }
    };

    if (animate) {
      rafRef.current = requestAnimationFrame(draw);
    } else {
      draw(0);
    }

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      gl.deleteBuffer(buf);
      gl.deleteTexture(tex);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    };
  }, [imgLoaded, gridSize, ditherMode, colorMode, primaryColor, secondaryColor, threshold, animate]);

  return <canvas ref={canvasRef} className={className} />;
}

export default DitherShader;
