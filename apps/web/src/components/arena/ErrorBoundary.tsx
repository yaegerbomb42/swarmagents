'use client';

import React, { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class PhysicsErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[Arena] Physics engine error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback || (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#040414]">
            <div className="text-center max-w-md px-6">
              <div className="text-3xl mb-4">⚠️</div>
              <div className="text-sm font-medium text-white/70 mb-2">3D Physics Engine Unavailable</div>
              <div className="text-xs text-white/40 mb-4">
                The Rapier3D WASM physics module failed to load. This usually happens when:
                <ul className="text-left mt-2 space-y-1 list-disc pl-4">
                  <li>The browser doesn't support WebAssembly</li>
                  <li>The WASM file is still being downloaded</li>
                  <li>Network issues prevented loading</li>
                </ul>
              </div>
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 rounded-lg bg-cyan-500/20 text-cyan-300 text-xs font-medium hover:bg-cyan-500/30 transition"
              >
                Retry
              </button>
              {this.state.error && (
                <pre className="mt-4 text-[9px] text-white/20 font-mono bg-black/30 p-2 rounded text-left overflow-auto max-h-32">
                  {this.state.error.message}
                </pre>
              )}
            </div>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
