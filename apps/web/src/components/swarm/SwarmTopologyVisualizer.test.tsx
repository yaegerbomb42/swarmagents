import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('three', () => {
  class Vector3 {
    x = 0;
    y = 0;
    z = 0;
    constructor(x = 0, y = 0, z = 0) {
      this.x = x;
      this.y = y;
      this.z = z;
    }
    copy() {
      return this;
    }
    setScalar() {
      return this;
    }
    setLength() {
      return this;
    }
    clone() {
      return new Vector3(this.x, this.y, this.z);
    }
    add() {
      return this;
    }
    multiplyScalar() {
      return this;
    }
  }

  class Scene {
    fog = null;
    add = vi.fn();
  }

  class Group {
    rotation = { y: 0 };
    add = vi.fn();
    remove = vi.fn();
  }

  class WebGLRenderer {
    domElement = document.createElement('canvas');
    setPixelRatio = vi.fn();
    setClearColor = vi.fn();
    setSize = vi.fn();
    render = vi.fn();
    dispose = vi.fn();
  }

  return {
    Scene,
    PerspectiveCamera: class {
      position = { set: vi.fn() };
      lookAt = vi.fn();
      aspect = 1;
      updateProjectionMatrix = vi.fn();
    },
    WebGLRenderer,
    FogExp2: class {},
    AmbientLight: class {},
    DirectionalLight: class {
      position = { set: vi.fn() };
    },
    Group,
    SphereGeometry: class {},
    MeshStandardMaterial: class {},
    Mesh: class {
      position = { copy: vi.fn() };
      scale = { setScalar: vi.fn() };
      userData: Record<string, unknown> = {};
    },
    BufferGeometry: class {
      setFromPoints = vi.fn();
    },
    LineBasicMaterial: class {},
    Line: class {},
    Raycaster: class {
      setFromCamera = vi.fn();
      intersectObjects = vi.fn(() => []);
    },
    Vector3,
    Vector2: class {
      x = 0;
      y = 0;
      constructor(x = 0, y = 0) {
        this.x = x;
        this.y = y;
      }
    },
  };
});

import SwarmTopologyVisualizer from './SwarmTopologyVisualizer';
import type { HierarchyAgent } from '@/lib/swarmHierarchy';

const agents: HierarchyAgent[] = [
  {
    id: 'role:architect',
    roleId: 'architect',
    parentId: null,
    status: 'running',
    label: 'Architect',
    activity: 'working',
    live: true,
  },
  {
    id: 'sub-1',
    roleId: 'implementer',
    parentId: 'role:architect',
    status: 'running',
    label: 'Worker',
    activity: 'communicating',
    live: true,
  },
];

describe('SwarmTopologyVisualizer', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      window.setTimeout(() => cb(performance.now()), 0),
    );
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders HUD with node count', () => {
    render(<SwarmTopologyVisualizer agents={agents} connected />);
    expect(screen.getByText('WebGL Topology')).toBeDefined();
    expect(screen.getByText(/2 nodes/)).toBeDefined();
    expect(screen.getByText(/SSE live/)).toBeDefined();
  });
});
