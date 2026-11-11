'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { unifiedApi } from '@/lib/api_client';

export type VoiceBriefingProps = {
  autoPlay?: boolean;
  className?: string;
};

export default function VoiceBriefing({ autoPlay = false, className = '' }: VoiceBriefingProps) {
  const [briefing, setBriefing] = useState('');
  const [loading, setLoading] = useState(true);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await unifiedApi.audioBriefing();
      setBriefing(data.briefing);
      return data.briefing;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Briefing unavailable');
      return '';
    } finally {
      setLoading(false);
    }
  }, []);

  const speak = useCallback((text: string) => {
    if (typeof window === 'undefined' || !window.speechSynthesis || !text) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.02;
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    utteranceRef.current = utterance;
    window.speechSynthesis.speak(utterance);
  }, []);

  const stop = useCallback(() => {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    setSpeaking(false);
  }, []);

  useEffect(() => {
    void load().then((text) => {
      if (autoPlay && text) speak(text);
    });
    return () => stop();
  }, [autoPlay, load, speak, stop]);

  return (
    <section
      data-testid="voice-briefing"
      className={`rounded-lg border border-white/10 bg-black/30 p-3 ${className}`}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <h3 className="text-[11px] font-medium text-zinc-200">Voice Briefing</h3>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void load().then((t) => t && speak(t))}
            disabled={loading || !briefing}
            className="tactile-icon p-1 text-cyan-400 hover:text-cyan-300 disabled:opacity-40"
            aria-label="Play briefing"
          >
            <Volume2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={stop}
            disabled={!speaking}
            className="tactile-icon p-1 text-zinc-400 hover:text-zinc-200 disabled:opacity-40"
            aria-label="Stop briefing"
          >
            <VolumeX className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {error ? (
        <p className="text-[10px] text-rose-300">{error}</p>
      ) : (
        <p className="text-[10px] text-zinc-400 leading-relaxed">
          {loading ? 'Loading mission briefing…' : briefing || 'No briefing available.'}
        </p>
      )}
    </section>
  );
}
