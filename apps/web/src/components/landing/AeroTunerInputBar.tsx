'use client';

import React, { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { 
  Paperclip, 
  Image as ImageIcon, 
  Video, 
  X, 
  Clock, 
  Zap, 
  ShieldCheck, 
  Sparkles,
  FileCode,
  FileText
} from 'lucide-react';

export interface AttachedMedia {
  id: string;
  name: string;
  size: number;
  type: string;
  category: 'image' | 'video' | 'code' | 'file';
  previewUrl?: string;
  textContent?: string;
}

interface AeroTunerInputBarProps {
  onLaunch?: (mission: string, budget: string, isYolo: boolean, attachments: AttachedMedia[]) => void;
  defaultBudget?: string;
  defaultYolo?: boolean;
}

const PRESET_PROMPTS = [
  { label: '⚡ Next.js Realtime Dashboard', text: 'Build a high-performance Next.js real-time analytics dashboard with WebSockets streaming telemetry, dark mode UI, and interactive chart visualizations.', budget: '2h' },
  { label: '🛡️ Full-Stack Auth & Token Service', text: 'Design and implement a production-grade OAuth2 and JWT authentication microservice with Redis token revocation and PostgreSQL schema.', budget: '4h' },
  { label: '🏖️ Hawaii Trip Plan & Multi-Doc Brief', text: 'Plan a 7-day multi-island Hawaii trip itinerary with flights, top boutique hotels, daily logistical schedules, budget breakdown, and packing guide.', budget: '1h' },
];

export default function AeroTunerInputBar({
  onLaunch,
  defaultBudget = '1h',
  defaultYolo = true,
}: AeroTunerInputBarProps) {
  const router = useRouter();
  const [missionText, setMissionText] = useState('');
  const [timeBudget, setTimeBudget] = useState(defaultBudget);
  const [isYolo, setIsYolo] = useState(defaultYolo);
  const [attachments, setAttachments] = useState<AttachedMedia[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const processFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    const newItems: AttachedMedia[] = [];

    for (const file of files) {
      const isImg = file.type.startsWith('image/');
      const isVid = file.type.startsWith('video/');
      const isCode = /\.(js|jsx|ts|tsx|py|go|rs|cpp|c|h|cs|html|css|json|yaml|yml|toml|sql|sh|env)$/i.test(file.name);
      
      let category: AttachedMedia['category'] = 'file';
      if (isImg) category = 'image';
      else if (isVid) category = 'video';
      else if (isCode) category = 'code';

      let previewUrl: string | undefined;
      let textContent: string | undefined;

      if (isImg || isVid) {
        previewUrl = URL.createObjectURL(file);
      } else if (file.size <= 300_000) {
        try {
          textContent = (await file.text()).slice(0, 30_000);
        } catch {
          /* ignore */
        }
      }

      newItems.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        size: file.size,
        type: file.type || 'application/octet-stream',
        category,
        previewUrl,
        textContent,
      });
    }

    setAttachments((prev) => [...prev, ...newItems]);
  };

  const handleRemoveAttachment = (id: string) => {
    setAttachments((prev) => {
      const item = prev.find((a) => a.id === id);
      if (item?.previewUrl) {
        try {
          URL.revokeObjectURL(item.previewUrl);
        } catch {}
      }
      return prev.filter((a) => a.id !== id);
    });
  };

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const text = missionText.trim();
    if (!text && attachments.length === 0) return;

    if (onLaunch) {
      onLaunch(text, timeBudget, isYolo, attachments);
      return;
    }

    try {
      sessionStorage.setItem('swarm_draft_mission', text);
      sessionStorage.setItem('swarm_draft_budget', timeBudget);
      sessionStorage.setItem('swarm_draft_yolo', isYolo ? 'true' : 'false');
      
      // Store lightweight attachment representations
      const serializedAttachments = attachments.map((a) => ({
        name: a.name,
        size: a.size,
        type: a.type,
        category: a.category,
        content: a.textContent,
      }));
      sessionStorage.setItem('swarm_draft_attachments', JSON.stringify(serializedAttachments));
    } catch {
      /* ignore */
    }

    router.push('/decomp');
  };

  // Drag & drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files);
    }
  };

  return (
    <div className="w-full max-w-3xl mx-auto text-left relative">
      <style jsx global>{`
        /* Aero Spectrum SVG Visualizer */
        .mai-spectrum-svg {
          width: 100%;
          height: 38px;
          display: block;
          margin-bottom: -12px;
          z-index: 2;
          position: relative;
          filter: drop-shadow(0 0 10px rgba(255, 20, 147, 0.25));
          pointer-events: none;
          opacity: 0.8;
          transition: opacity 0.4s ease, filter 0.4s ease;
        }

        .mai-input-wrap:focus-within .mai-spectrum-svg,
        .mai-spectrum-svg.active {
          opacity: 1;
          filter: drop-shadow(0 0 14px rgba(255, 20, 147, 0.45));
        }

        .mai-spectrum-wave {
          stroke-dasharray: 240;
          stroke-dashoffset: 0;
          animation: mai-wave-draw 7s ease-in-out infinite alternate,
                     mai-wave-shift 2.5s ease-in-out infinite alternate;
        }

        .mai-spectrum-wave-1 {
          animation-delay: -1.2s, -0.6s;
        }
        .mai-spectrum-wave-2 {
          animation-delay: -2.8s, -1.4s;
        }
        .mai-spectrum-wave-3 {
          animation-delay: -4.5s, -2.1s;
        }

        @keyframes mai-wave-draw {
          0% { stroke-dashoffset: -120; }
          100% { stroke-dashoffset: 120; }
        }

        @keyframes mai-wave-shift {
          0% { transform: translateY(-0.75px); }
          100% { transform: translateY(0.75px); }
        }

        /* Aero Input Container */
        .mai-aero-container {
          position: relative;
          background: linear-gradient(160deg, #1c1c24 0%, #101015 100%);
          border-radius: 16px;
          box-shadow:
            0px 0px 0px 1px rgba(255, 255, 255, 0.08) inset,
            0px 0px 0px 1px rgba(0, 0, 0, 0.8),
            0px 14px 34px rgba(0, 0, 0, 0.6);
          transform-style: preserve-3d;
          transition: box-shadow 0.3s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.3s ease, transform 0.3s ease;
        }

        .mai-input-wrap:focus-within .mai-aero-container {
          box-shadow:
            0px 0px 0px 1px rgba(255, 255, 255, 0.16) inset,
            0px 0px 0px 1px rgba(255, 20, 147, 0.5),
            0px 16px 40px rgba(0, 0, 0, 0.8),
            0px 0px 24px rgba(255, 20, 147, 0.22);
        }

        .mai-aero-chamfer {
          position: absolute;
          inset: 0;
          border-radius: inherit;
          box-shadow: 0px 1px 0px rgba(255, 255, 255, 0.07) inset;
          pointer-events: none;
        }

        .mai-aero-send-btn {
          appearance: none;
          border: none;
          outline: none;
          cursor: pointer;
          width: 40px;
          height: 40px;
          border-radius: 11px;
          background: rgba(255, 255, 255, 0.05);
          box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08) inset;
          display: flex;
          align-items: center;
          justify-content: center;
          color: #9d9cb3;
          padding: 0;
          flex-shrink: 0;
          transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .mai-aero-send-btn:hover:not(:disabled) {
          background: #ff1493;
          color: #ffffff;
          box-shadow: 0 0 16px rgba(255, 20, 147, 0.6), 0 2px 8px rgba(0, 0, 0, 0.4);
          transform: scale(1.05);
        }

        .mai-aero-send-btn:active:not(:disabled) {
          transform: scale(0.95);
          box-shadow: 0 0 10px rgba(255, 20, 147, 0.4);
        }
      `}</style>

      {/* Hidden universal file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            processFiles(e.target.files);
            e.target.value = '';
          }
        }}
      />

      <div
        ref={wrapRef}
        className="mai-input-wrap relative flex flex-col"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onMouseMove={(e) => {
          if (!wrapRef.current || !isFocused) return;
          const rect = wrapRef.current.getBoundingClientRect();
          const px = (e.clientX - rect.left) / rect.width - 0.5;
          const py = (e.clientY - rect.top) / rect.height - 0.5;
          setTilt({ x: py * -4, y: px * 4 });
        }}
        onMouseLeave={() => setTilt({ x: 0, y: 0 })}
        style={{
          perspective: '900px',
        }}
      >
        {/* Subtle Oscillating Spectrum Visualizer */}
        <svg 
          className={`mai-spectrum-svg ${isFocused ? 'active' : ''}`} 
          viewBox="0 0 240 48" 
          preserveAspectRatio="none" 
          aria-hidden="true"
        >
          <path className="mai-spectrum-wave mai-spectrum-wave-1" d="M0,24 Q20,10 40,24 T80,24 T120,24 T160,24 T200,24 T240,24" fill="none" stroke="#ff1493" strokeWidth="1.2" strokeLinecap="round" opacity="0.85"></path>
          <path className="mai-spectrum-wave mai-spectrum-wave-2" d="M0,24 Q30,16 60,24 T120,24 T180,24 T240,24" fill="none" stroke="#ff69b4" strokeWidth="0.9" strokeLinecap="round" opacity="0.55"></path>
          <path className="mai-spectrum-wave mai-spectrum-wave-3" d="M0,24 Q40,18 80,24 T160,24 T240,24" fill="none" stroke="#ffa3cb" strokeWidth="0.7" strokeLinecap="round" opacity="0.35"></path>
        </svg>

        {/* Base Container */}
        <div
          className={`mai-aero-container p-4 ${isDragging ? 'ring-2 ring-pink-500 bg-pink-950/20' : ''}`}
          style={{
            transform: `rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`,
            transition: isFocused ? 'transform 0.15s ease-out' : 'transform 0.4s ease-out',
          }}
        >
          <div className="mai-aero-chamfer" aria-hidden="true"></div>

          {/* Top Controls: Status + YOLO Mode */}
          <div className="flex items-center justify-between pb-2.5 border-b border-white/[0.06] mb-3">
            <div className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-pink-400">
              <Sparkles size={13} className="text-pink-400 animate-pulse" />
              <span>Aero Tuner · Task Context</span>
            </div>
            
            <button
              type="button"
              onClick={() => setIsYolo(!isYolo)}
              className={`inline-flex items-center gap-1.5 text-[10px] font-mono font-semibold px-2.5 py-1 rounded-full transition ${
                isYolo
                  ? 'bg-pink-500/20 text-pink-300 border border-pink-500/35 shadow-[0_0_12px_rgba(255,20,147,0.25)]'
                  : 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
              }`}
            >
              {isYolo ? <Zap size={11} className="text-pink-400 animate-pulse" /> : <ShieldCheck size={11} />}
              {isYolo ? '⚡ YOLO Rapid-Fire' : '🛡️ Sandboxed Safe'}
            </button>
          </div>

          {/* Input Text Area */}
          <div className="relative">
            <textarea
              ref={textareaRef}
              rows={2}
              value={missionText}
              onChange={(e) => setMissionText(e.target.value)}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              placeholder="Input task context, describe project, or drop files, images, & videos..."
              className="w-full bg-transparent border-none outline-none text-[13.5px] text-zinc-100 placeholder:text-zinc-500 resize-none font-sans leading-relaxed tracking-[-0.01em]"
            />
          </div>

          {/* Attached Media Previews */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-2.5 pb-2">
              {attachments.map((att) => (
                <div
                  key={att.id}
                  className="group relative flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] hover:border-pink-500/40 transition text-xs"
                >
                  {att.category === 'image' && att.previewUrl ? (
                    <img src={att.previewUrl} alt={att.name} className="w-5 h-5 rounded object-cover" />
                  ) : att.category === 'video' ? (
                    <Video size={14} className="text-pink-400" />
                  ) : att.category === 'code' ? (
                    <FileCode size={14} className="text-cyan-400" />
                  ) : (
                    <FileText size={14} className="text-amber-400" />
                  )}

                  <span className="max-w-[130px] truncate text-[11px] text-zinc-300 font-mono">
                    {att.name}
                  </span>
                  <span className="text-[9px] text-zinc-500 font-mono">
                    {formatFileSize(att.size)}
                  </span>

                  <button
                    type="button"
                    onClick={() => handleRemoveAttachment(att.id)}
                    className="text-zinc-500 hover:text-red-400 transition p-0.5 rounded"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Preset Prompts Chips */}
          <div className="flex flex-wrap gap-1.5 py-2">
            {PRESET_PROMPTS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  setMissionText(p.text);
                  setTimeBudget(p.budget);
                }}
                className="text-[10px] px-2.5 py-1 rounded-md border border-white/[0.06] bg-white/[0.02] text-zinc-400 hover:text-white hover:border-pink-500/30 transition truncate max-w-[260px]"
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Bottom Bar: Attachments Triggers + Time Budget + Send */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-white/[0.06]">
            {/* Media Upload Buttons */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/[0.03] hover:bg-white/[0.07] border border-white/[0.08] text-zinc-400 hover:text-zinc-200 text-[11px] transition"
                title="Attach any file (docs, code, config)"
              >
                <Paperclip size={12} />
                <span>Files</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  if (fileInputRef.current) {
                    fileInputRef.current.accept = 'image/*';
                    fileInputRef.current.click();
                    setTimeout(() => {
                      if (fileInputRef.current) fileInputRef.current.accept = '';
                    }, 500);
                  }
                }}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/[0.03] hover:bg-white/[0.07] border border-white/[0.08] text-zinc-400 hover:text-zinc-200 text-[11px] transition"
                title="Attach image files (PNG, JPG, WebP)"
              >
                <ImageIcon size={12} />
                <span>Images</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  if (fileInputRef.current) {
                    fileInputRef.current.accept = 'video/*';
                    fileInputRef.current.click();
                    setTimeout(() => {
                      if (fileInputRef.current) fileInputRef.current.accept = '';
                    }, 500);
                  }
                }}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/[0.03] hover:bg-white/[0.07] border border-white/[0.08] text-zinc-400 hover:text-zinc-200 text-[11px] transition"
                title="Attach video files (MP4, WebM, MOV)"
              >
                <Video size={12} />
                <span>Videos</span>
              </button>
            </div>

            {/* Time Budget Selector & Send Action */}
            <div className="flex items-center gap-3 ml-auto">
              <div className="flex items-center gap-1.5">
                <span className="text-[10.5px] text-zinc-500 flex items-center gap-1 font-mono">
                  <Clock size={11} /> Budget:
                </span>
                {['15m', '1h', '4h', '1d', '3d'].map((b) => (
                  <button
                    key={b}
                    type="button"
                    onClick={() => setTimeBudget(b)}
                    className={`text-[10px] font-mono px-2 py-0.5 rounded transition ${
                      timeBudget === b
                        ? 'bg-pink-500/20 text-pink-300 border border-pink-500/40 font-bold shadow-[0_0_8px_rgba(255,20,147,0.2)]'
                        : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    {b}
                  </button>
                ))}
              </div>

              {/* Aero Submit Button */}
              <button
                type="button"
                onClick={() => handleSubmit()}
                disabled={!missionText.trim() && attachments.length === 0}
                className="mai-aero-send-btn disabled:opacity-30 disabled:cursor-not-allowed"
                aria-label="Decompose and execute mission"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14"></path>
                  <path d="M12 5l7 7-7 7"></path>
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
