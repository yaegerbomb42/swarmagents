'use client';

import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

// ════════════════════════════════════════════════════════════
//  Globe3D — Three.js globe w/ markers (lat/lng)
//  No R3F dependency — pure three.js for minimal bundle
// ════════════════════════════════════════════════════════════

export interface GlobeMarker {
  lat: number;
  lng: number;
  src?: string;
  label: string;
  color?: string;
}

export interface Globe3DConfig {
  atmosphereColor?: string;
  atmosphereIntensity?: number;
  bumpScale?: number;
  autoRotateSpeed?: number;
  globeColor?: string;
  markerColor?: string;
}

export interface Globe3DProps {
  markers?: GlobeMarker[];
  config?: Globe3DConfig;
  className?: string;
  onMarkerClick?: (marker: GlobeMarker) => void;
  onMarkerHover?: (marker: GlobeMarker | null) => void;
}

function latLngToVec3(lat: number, lng: number, radius: number): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lng + 180) * (Math.PI / 180);
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta)
  );
}

export function Globe3D({
  markers = [],
  config = {},
  className = '',
  onMarkerClick,
  onMarkerHover,
}: Globe3DProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [hovered, setHovered] = useState<GlobeMarker | null>(null);
  const hoveredRef = useRef<GlobeMarker | null>(null);

  const {
    atmosphereColor = '#4da6ff',
    atmosphereIntensity = 20,
    autoRotateSpeed = 0.3,
    globeColor = '#0a0a1a',
    markerColor = '#a78bfa',
  } = config;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const width = mount.clientWidth;
    const height = mount.clientHeight;

    // Scene + camera + renderer
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.z = 3.5;

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    mount.appendChild(renderer.domElement);

    // Globe
    const globeGeo = new THREE.SphereGeometry(1, 64, 64);
    const globeMat = new THREE.MeshPhongMaterial({
      color: globeColor,
      emissive: '#0a0a1a',
      shininess: 30,
      specular: 0x222244,
    });
    const globe = new THREE.Mesh(globeGeo, globeMat);
    scene.add(globe);

    // Wireframe overlay for visual richness
    const wireGeo = new THREE.SphereGeometry(1.001, 32, 32);
    const wireMat = new THREE.MeshBasicMaterial({
      color: '#3b82f6',
      wireframe: true,
      transparent: true,
      opacity: 0.15,
    });
    const wire = new THREE.Mesh(wireGeo, wireMat);
    scene.add(wire);

    // Atmosphere
    const atmGeo = new THREE.SphereGeometry(1.08, 64, 64);
    const atmMat = new THREE.ShaderMaterial({
      uniforms: {
        glowColor: { value: new THREE.Color(atmosphereColor) },
        viewVector: { value: camera.position.clone() },
      },
      vertexShader: `
        uniform vec3 viewVector;
        varying float intensity;
        void main() {
          vec3 vNormal = normalize( normalMatrix * normal );
          vec3 vNormel = normalize( normalMatrix * viewVector );
          intensity = pow( 0.5 - dot(vNormal, vNormel), 3.0 );
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }
      `,
      fragmentShader: `
        uniform vec3 glowColor;
        varying float intensity;
        void main() {
          gl_FragColor = vec4( glowColor, 1.0 ) * intensity * ${(atmosphereIntensity / 20).toFixed(2)};
        }
      `,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
    });
    const atm = new THREE.Mesh(atmGeo, atmMat);
    scene.add(atm);

    // Lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(2, 1, 3);
    scene.add(dir);

    // Markers
    const markerGroup = new THREE.Group();
    scene.add(markerGroup);

    const markerMeshes: { mesh: THREE.Mesh; data: GlobeMarker }[] = [];
    markers.forEach((m) => {
      const pos = latLngToVec3(m.lat, m.lng, 1.02);
      const dotGeo = new THREE.SphereGeometry(0.015, 16, 16);
      const dotMat = new THREE.MeshBasicMaterial({ color: m.color || markerColor });
      const dot = new THREE.Mesh(dotGeo, dotMat);
      dot.position.copy(pos);
      markerGroup.add(dot);

      // Glow halo
      const haloGeo = new THREE.SphereGeometry(0.035, 16, 16);
      const haloMat = new THREE.MeshBasicMaterial({
        color: m.color || markerColor,
        transparent: true,
        opacity: 0.35,
      });
      const halo = new THREE.Mesh(haloGeo, haloMat);
      halo.position.copy(pos);
      markerGroup.add(halo);

      // Pulsing ring
      const ringGeo = new THREE.RingGeometry(0.04, 0.05, 24);
      const ringMat = new THREE.MeshBasicMaterial({
        color: m.color || markerColor,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.6,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.copy(pos);
      ring.lookAt(0, 0, 0);
      markerGroup.add(ring);

      (dot as any).pulseRing = ring;
      (dot as any).pulseRingPhase = Math.random() * Math.PI * 2;
      markerMeshes.push({ mesh: dot, data: m });
    });

    // Raycaster for hover/click
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    const onMove = (e: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(markerMeshes.map((m) => m.mesh));
      if (intersects.length > 0) {
        const hit = markerMeshes.find((m) => m.mesh === intersects[0].object);
        if (hit && hit.data !== hoveredRef.current) {
          hoveredRef.current = hit.data;
          setHovered(hit.data);
          onMarkerHover?.(hit.data);
          renderer.domElement.style.cursor = 'pointer';
        }
      } else if (hoveredRef.current) {
        hoveredRef.current = null;
        setHovered(null);
        onMarkerHover?.(null);
        renderer.domElement.style.cursor = 'grab';
      }
    };
    const onClick = () => {
      if (hoveredRef.current) onMarkerClick?.(hoveredRef.current);
    };
    renderer.domElement.style.cursor = 'grab';

    renderer.domElement.addEventListener('mousemove', onMove);
    renderer.domElement.addEventListener('click', onClick);

    // Drag-to-rotate
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let userRotX = 0;
    let userRotY = 0;
    const onDown = (e: MouseEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      renderer.domElement.style.cursor = 'grabbing';
    };
    const onUp = () => {
      dragging = false;
      renderer.domElement.style.cursor = 'grab';
    };
    const onDrag = (e: MouseEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      userRotY += dx * 0.005;
      userRotX += dy * 0.005;
      userRotX = Math.max(-1.2, Math.min(1.2, userRotX));
    };
    renderer.domElement.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('mousemove', onDrag);

    // Animation loop
    let raf = 0;
    const start = performance.now();
    const animate = () => {
      const t = (performance.now() - start) / 1000;
      globe.rotation.y = userRotY + t * autoRotateSpeed * 0.1;
      globe.rotation.x = userRotX;
      wire.rotation.copy(globe.rotation);
      markerGroup.rotation.copy(globe.rotation);

      // Pulse rings
      markerMeshes.forEach(({ mesh }) => {
        const ring = (mesh as any).pulseRing as THREE.Mesh;
        const phase = (mesh as any).pulseRingPhase as number;
        const s = 1 + (Math.sin(t * 2 + phase) + 1) * 0.6;
        ring.scale.set(s, s, s);
        (ring.material as THREE.MeshBasicMaterial).opacity = 0.6 * (1 - (s - 1) / 1.2);
      });

      renderer.render(scene, camera);
      raf = requestAnimationFrame(animate);
    };
    animate();

    // Resize handling
    const onResize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    return () => {
      cancelAnimationFrame(raf);
      renderer.domElement.removeEventListener('mousemove', onMove);
      renderer.domElement.removeEventListener('click', onClick);
      renderer.domElement.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('mousemove', onDrag);
      ro.disconnect();
      mount.removeChild(renderer.domElement);
      renderer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={`relative w-full h-full ${className}`}>
      <div ref={mountRef} className="w-full h-full" />
      {hovered && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 pointer-events-none bg-gray-900/90 backdrop-blur-sm border border-gray-700/60 rounded-xl px-3 py-1.5 text-xs text-white">
          {hovered.label}
        </div>
      )}
    </div>
  );
}

export default Globe3D;
