'use client';

import { useMemo, useState } from 'react';
import { Clock, ChevronDown } from 'lucide-react';
import {
  TIME_PRESETS,
  parseTimeToMinutes,
  formatMinutes,
  expectedLeavesHint,
  computeBudgetTargets,
} from '@/lib/timeBudget';

export type TimeUnit = 'seconds' | 'minutes' | 'hours' | 'days';

export interface TimeBudgetValue {
  minutes: number;
  label: string;
}

interface TimeBudgetControlProps {
  value: TimeBudgetValue;
  onChange: (next: TimeBudgetValue) => void;
  disabled?: boolean;
  compact?: boolean;
  showHint?: boolean;
  /** Hide the built-in "Time Budget" row (parent already labels it). */
  hideLabel?: boolean;
  className?: string;
}

function toValue(minutes: number): TimeBudgetValue {
  const m = Math.max(1 / 3, Math.round(minutes * 100) / 100);
  return { minutes: m, label: formatMinutes(m) };
}

function unitFor(minutes: number): TimeUnit {
  if (minutes < 1) return 'seconds';
  if (minutes < 120) return 'minutes';
  if (minutes < 48 * 60) return 'hours';
  return 'days';
}

function displayAmount(minutes: number, unit: TimeUnit): number {
  if (unit === 'seconds') return Math.round(minutes * 60);
  if (unit === 'minutes') return Math.round(minutes);
  if (unit === 'hours') return Math.round((minutes / 60) * 10) / 10;
  return Math.round((minutes / (24 * 60)) * 10) / 10;
}

function fromAmount(amount: number, unit: TimeUnit): number {
  if (unit === 'seconds') return Math.max(1 / 3, Math.round(amount) / 60);
  if (unit === 'minutes') return Math.max(1 / 3, Math.round(amount));
  if (unit === 'hours') return Math.max(1 / 3, Math.round(amount * 60));
  return Math.max(1 / 3, Math.round(amount * 24 * 60));
}

export default function TimeBudgetControl({
  value,
  onChange,
  disabled = false,
  compact = false,
  showHint = true,
  hideLabel = false,
  className = '',
}: TimeBudgetControlProps) {
  const [showPresets, setShowPresets] = useState(false);
  const [unit, setUnit] = useState<TimeUnit>(() => unitFor(value.minutes));
  const [customText, setCustomText] = useState('');

  const targets = useMemo(() => computeBudgetTargets(value.minutes), [value.minutes]);
  const amount = displayAmount(value.minutes, unit);

  const slider = useMemo(() => {
    if (unit === 'seconds') return { min: 20, max: 120, step: 5 };
    if (unit === 'minutes') return { min: 1, max: 120, step: 1 };
    if (unit === 'hours') return { min: 0.5, max: 48, step: 0.5 };
    return { min: 1, max: 100, step: 1 };
  }, [unit]);

  const applyMinutes = (minutes: number) => {
    const next = toValue(minutes);
    onChange(next);
    setUnit(unitFor(next.minutes));
    setCustomText('');
  };

  const handleSlider = (raw: number) => {
    applyMinutes(fromAmount(raw, unit));
  };

  const handleCustomCommit = () => {
    if (!customText.trim()) return;
    applyMinutes(parseTimeToMinutes(customText));
  };

  return (
    <div className={`space-y-2.5 ${className}`}>
      {!hideLabel && (
        <div className="flex items-center justify-between gap-2">
          <label className="text-[11px] text-zinc-400 flex items-center gap-1.5">
            <Clock size={12} className="text-zinc-500" />
            Time estimate
          </label>
          <span className="text-[11px] font-mono text-zinc-300">{value.label}</span>
        </div>
      )}

      <div className="relative">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setShowPresets((s) => !s)}
          className="w-full flex items-center justify-between px-3 py-2 text-[13px] text-zinc-100 bg-[#141416] border border-[#2a2a2e] rounded-md hover:border-zinc-600 disabled:opacity-40 transition-colors"
        >
          <span className="font-medium">{value.label}</span>
          <ChevronDown
            size={14}
            className={`text-[#6b6b73] transition-transform ${showPresets ? 'rotate-180' : ''}`}
          />
        </button>
        {showPresets && (
          <div className="absolute z-20 mt-1.5 w-full rounded-md border border-[#2a2a2e] bg-[#141416] shadow-xl shadow-black/40 overflow-hidden max-h-56 overflow-y-auto">
            {TIME_PRESETS.map((preset) => (
              <button
                key={preset.value}
                type="button"
                onClick={() => {
                  applyMinutes(preset.minutes);
                  setShowPresets(false);
                }}
                className={`w-full text-left px-3 py-2 text-[12px] flex items-center justify-between ${
                  value.minutes === preset.minutes && value.label === preset.value
                    ? 'text-zinc-100 bg-white/5'
                    : 'text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.04]'
                }`}
              >
                <span>{preset.label}</span>
                <span className="text-[10px] text-zinc-600 font-mono">
                  ~{computeBudgetTargets(preset.minutes).targetLeaves} tasks
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {!compact && (
        <>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={slider.min}
              max={slider.max}
              step={slider.step}
              disabled={disabled}
              value={amount}
              onChange={(e) => handleSlider(parseFloat(e.target.value) || slider.min)}
              className="w-[4.5rem] bg-[#141416] border border-[#2a2a2e] rounded-md px-2 py-1.5 text-[12px] text-zinc-100 font-mono focus:outline-none focus:border-zinc-500"
            />
            <div className="flex rounded-md border border-[#2a2a2e] overflow-hidden bg-[#141416]">
              {(['seconds', 'minutes', 'hours', 'days'] as TimeUnit[]).map((u) => (
                <button
                  key={u}
                  type="button"
                  disabled={disabled}
                  onClick={() => setUnit(u)}
                  className={`px-2 py-1.5 text-[10px] font-medium uppercase tracking-wide ${
                    unit === u
                      ? 'bg-white/10 text-zinc-100'
                      : 'text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.04]'
                  }`}
                >
                  {u === 'seconds' ? 'sec' : u === 'minutes' ? 'min' : u === 'hours' ? 'hrs' : 'days'}
                </button>
              ))}
            </div>
            <input
              type="range"
              min={slider.min}
              max={slider.max}
              step={slider.step}
              disabled={disabled}
              value={Math.min(slider.max, Math.max(slider.min, amount))}
              onChange={(e) => handleSlider(parseFloat(e.target.value))}
              className="flex-1 accent-zinc-400 h-1.5"
            />
          </div>

          <div className="flex gap-2">
            <input
              type="text"
              disabled={disabled}
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCustomCommit()}
              placeholder="Custom: 45m, 2.5h, 1d…"
              className="flex-1 bg-[#141416] border border-[#2a2a2e] rounded-md px-2.5 py-1.5 text-[12px] text-zinc-100 font-mono placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
            />
            <button
              type="button"
              disabled={disabled || !customText.trim()}
              onClick={handleCustomCommit}
              className="px-3 py-1.5 text-[11px] font-medium rounded-md border border-[#2a2a2e] text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04] disabled:opacity-40"
            >
              Set
            </button>
          </div>
        </>
      )}

      {showHint && (
        <div className="flex items-center justify-between text-[10px] font-mono text-zinc-600">
          <span>{expectedLeavesHint(value.minutes)}</span>
          <span>
            deepen {'>'}{targets.deepenAboveMinutes}m · depth {'≤'}{targets.maxDepth}
          </span>
        </div>
      )}
    </div>
  );
}

export function timeBudgetFromHours(hours: number): TimeBudgetValue {
  return toValue(Math.round(hours * 60));
}

export function timeBudgetFromLabel(label: string): TimeBudgetValue {
  const minutes = parseTimeToMinutes(label);
  return { minutes, label: label || formatMinutes(minutes) };
}
