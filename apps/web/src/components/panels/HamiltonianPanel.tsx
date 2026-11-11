'use client';

import React, { useState, useEffect } from 'react';
import { Brain, Zap, AlertCircle, CheckCircle, Settings, Play, Pause, RotateCcw } from 'lucide-react';
import { HamiltonianRouterIcon } from '@/components/ui/concept-icons';

interface HamiltonianStatus {
  provider: string;
  mode: string;
  active: boolean;
  total_calls: number;
  fallback_count: number;
  fallback_rate: number;
  json_parse_success_rate: number;
  action_validation_rate: number;
  provider_errors: number;
}

export default function HamiltonianPanel() {
  const [status, setStatus] = useState<HamiltonianStatus>({
    provider: 'auto',
    mode: 'idle',
    active: false,
    total_calls: 0,
    fallback_count: 0,
    fallback_rate: 0,
    json_parse_success_rate: 0,
    action_validation_rate: 0,
    provider_errors: 0,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const response = await fetch('/api/hamiltonian');
        if (response.ok) {
          const data = await response.json();
          setStatus(data);
        }
      } catch (error) {
        console.error('Failed to fetch Hamiltonian status:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 2000);
    return () => clearInterval(interval);
  }, []);

  const handleAction = async (action: string) => {
    try {
      const response = await fetch('/api/hamiltonian', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (response.ok) {
        const data = await response.json();
        if (data.status) {
          setStatus(prev => ({ ...prev, ...data.status }));
        }
      }
    } catch (error) {
      console.error('Failed to execute Hamiltonian action:', error);
    }
  };

  return (
    <div className="border-b border-gray-100 p-4">
      <h3 className="text-xs font-semibold text-gray-900 uppercase tracking-wider mb-3 flex items-center gap-2">
        <HamiltonianRouterIcon size={20} />
        Hamiltonian Decision Engine
      </h3>

      {loading ? (
        <div className="text-sm text-gray-400">Loading...</div>
      ) : (
        <div className="space-y-3">
          {/* Provider Status */}
          <div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[11px] uppercase tracking-wider text-gray-500">Provider</div>
              <div className={`text-[11px] font-medium ${status.active ? 'text-green-600' : 'text-gray-600'}`}>
                {status.provider}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-[11px] uppercase tracking-wider text-gray-500">Mode</div>
              <div className="text-[11px] font-medium text-gray-900">{status.mode}</div>
            </div>
          </div>

          {/* Metrics */}
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl border border-gray-100 bg-gray-50 p-2">
              <div className="text-[10px] uppercase tracking-wider text-gray-500">Total Calls</div>
              <div className="mt-0.5 font-semibold text-gray-900 text-sm">{status.total_calls}</div>
            </div>
            <div className="rounded-xl border border-gray-100 bg-gray-50 p-2">
              <div className="text-[10px] uppercase tracking-wider text-gray-500">Fallback Rate</div>
              <div className={`mt-0.5 font-semibold text-sm ${(status.fallback_rate * 100).toFixed(1)}%`}>
                {(status.fallback_rate * 100).toFixed(1)}%
              </div>
            </div>
            <div className="rounded-xl border border-gray-100 bg-gray-50 p-2">
              <div className="text-[10px] uppercase tracking-wider text-gray-500">JSON Success</div>
              <div className="mt-0.5 font-semibold text-green-600 text-sm">
                {(status.json_parse_success_rate * 100).toFixed(1)}%
              </div>
            </div>
            <div className="rounded-xl border border-gray-100 bg-gray-50 p-2">
              <div className="text-[10px] uppercase tracking-wider text-gray-500">Action Valid</div>
              <div className="mt-0.5 font-semibold text-green-600 text-sm">
                {(status.action_validation_rate * 100).toFixed(1)}%
              </div>
            </div>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleAction('reset')}
              className="flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2 text-gray-700 text-xs font-medium hover:bg-gray-50 transition-colors flex items-center justify-center gap-1"
            >
              <RotateCcw size={12} />
              Reset Metrics
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
