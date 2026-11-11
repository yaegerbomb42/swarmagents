'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Radio } from 'lucide-react';
import { unifiedApi } from '@/lib/api_client';
import { buildWsUrl } from '@/lib/config';
import { useAgentTelemetry } from '@/hooks/useAgentTelemetry';
import type { AgentSandbox } from '@/lib/sandboxTypes';

export type GroupChatFeedMessage = {
  id: number;
  sender_id: string;
  sender_role: string;
  message_type: string;
  content: string;
  timestamp: string;
};

type AgentNode = {
  id: string;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  vx: number;
  vy: number;
  hue: number;
  lastMsgAt: number;
  trail: Array<{ x: number; y: number }>;
  source: 'groupchat' | 'sandbox';
  label?: string;
};

export type SwarmCanvasProps = {
  sessionId?: string | null;
  className?: string;
  /** Poll interval for groupchat feed (ms). WS upgrades when available. */
  pollMs?: number;
  trailLength?: number;
};

const MESSAGE_TYPE_HUE: Record<string, number> = {
  ANNOUNCE: 190,
  LOCK_REQUEST: 45,
  BROADCAST: 280,
  CONSENSUS_REQUEST: 140,
};

function senderHue(senderId: string): number {
  let h = 0;
  for (let i = 0; i < senderId.length; i += 1) h = (h * 31 + senderId.charCodeAt(i)) % 360;
  return h;
}

function anchorFor(id: string, w: number, h: number): { x: number; y: number } {
  const hue = senderHue(id);
  const angle = (hue / 360) * Math.PI * 2;
  const radius = 0.22 + ((hue % 97) / 97) * 0.28;
  return {
    x: w * (0.5 + Math.cos(angle) * radius),
    y: h * (0.5 + Math.sin(angle) * radius),
  };
}

function sandboxHue(sb: AgentSandbox): number {
  const key = sb.agentId || sb.id;
  return senderHue(key);
}

function sandboxTarget(
  sb: AgentSandbox,
  idx: number,
  w: number,
  h: number,
): { x: number; y: number } {
  if (sb.position) {
    return {
      x: (sb.position.x / 800) * w,
      y: (sb.position.y / 420) * h,
    };
  }
  return anchorFor(sb.agentId || sb.id, w, h);
}

function upsertNode(
  nodes: Map<string, AgentNode>,
  id: string,
  target: { x: number; y: number },
  hue: number,
  source: AgentNode['source'],
  label?: string,
): void {
  const now = performance.now();
  const existing = nodes.get(id);
  if (!existing) {
    nodes.set(id, {
      id,
      x: target.x,
      y: target.y,
      targetX: target.x,
      targetY: target.y,
      vx: 0,
      vy: 0,
      hue,
      lastMsgAt: now,
      trail: [{ x: target.x, y: target.y }],
      source,
      label,
    });
    return;
  }
  existing.targetX = target.x;
  existing.targetY = target.y;
  existing.hue = hue;
  existing.source = source;
  if (label) existing.label = label;
  if (source === 'groupchat') existing.lastMsgAt = now;
}

function useGroupChatFeed(pollMs: number) {
  const [messages, setMessages] = useState<GroupChatFeedMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const lastIdRef = useRef(0);

  const ingest = useCallback((batch: GroupChatFeedMessage[]) => {
    if (!batch.length) return;
    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m.id));
      const merged = [...prev];
      for (const m of batch) {
        if (!seen.has(m.id)) merged.push(m);
      }
      return merged.slice(-120);
    });
    const maxId = Math.max(...batch.map((m) => m.id));
    if (maxId > lastIdRef.current) lastIdRef.current = maxId;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      try {
        const page = await unifiedApi.groupchatMessages({ limit: 80 });
        if (cancelled) return;
        ingest(page.messages as GroupChatFeedMessage[]);
        setConnected(true);
      } catch {
        if (!cancelled) setConnected(false);
      }
    };

    const startWs = () => {
      void poll();
      if (typeof WebSocket === 'undefined') {
        poll();
        pollTimer = setInterval(poll, pollMs);
        return;
      }
      try {
        ws = new WebSocket(buildWsUrl('/api/v1/groupchat/ws'));
        ws.onopen = () => {
          if (!cancelled) setConnected(true);
        };
        ws.onmessage = (ev) => {
          try {
            const raw = JSON.parse(ev.data as string) as Record<string, unknown>;
            if (Array.isArray(raw)) {
              ingest(raw as GroupChatFeedMessage[]);
              return;
            }
            const id = Number(raw.message_id ?? raw.id ?? 0);
            const senderId = String(raw.sender_id ?? raw.agent_id ?? '');
            if (!senderId) return;
            ingest([
              {
                id: id || Date.now(),
                sender_id: senderId,
                sender_role: String(raw.sender_role ?? 'worker'),
                message_type: String(raw.message_type ?? raw.type ?? 'ANNOUNCE'),
                content: String(raw.content ?? ''),
                timestamp: String(raw.timestamp ?? new Date().toISOString()),
              },
            ]);
          } catch {
            /* ignore malformed frames */
          }
        };
        ws.onerror = () => {
          ws?.close();
          ws = null;
          if (!cancelled) {
            poll();
            pollTimer = setInterval(poll, pollMs);
          }
        };
        ws.onclose = () => {
          if (!cancelled && !pollTimer) {
            poll();
            pollTimer = setInterval(poll, pollMs);
          }
        };
      } catch {
        poll();
        pollTimer = setInterval(poll, pollMs);
      }
    };

    startWs();
    return () => {
      cancelled = true;
      ws?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [ingest, pollMs]);

  return { messages, connected };
}

export default function SwarmCanvas({
  sessionId = null,
  className = '',
  pollMs = 2000,
  trailLength = 24,
}: SwarmCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<Map<string, AgentNode>>(new Map());
  const animRef = useRef(0);
  const sizeRef = useRef({ w: 640, h: 360 });
  const { messages, connected: groupchatConnected } = useGroupChatFeed(pollMs);
  const { sandboxes, connected: telemetryConnected } = useAgentTelemetry({
    sessionId: sessionId ?? undefined,
    enabled: Boolean(sessionId),
    pollFallbackMs: pollMs,
  });
  const [agentCount, setAgentCount] = useState(0);
  const [fps, setFps] = useState(0);
  const connected = groupchatConnected || telemetryConnected;

  useEffect(() => {
    const nodes = nodesRef.current;
    const { w, h } = sizeRef.current;

    for (const msg of messages) {
      const id = msg.sender_id;
      const anchor = anchorFor(id, w, h);
      const pulseHue = MESSAGE_TYPE_HUE[msg.message_type] ?? senderHue(id);
      upsertNode(nodes, id, anchor, pulseHue, 'groupchat', id);
      const node = nodes.get(id)!;
      const dx = anchor.x - node.x;
      const dy = anchor.y - node.y;
      node.vx += dx * 0.04;
      node.vy += dy * 0.04;
    }
  }, [messages]);

  useEffect(() => {
    const nodes = nodesRef.current;
    const { w, h } = sizeRef.current;
    const active = new Set<string>();

    sandboxes.forEach((sb, idx) => {
      const id = sb.agentId || sb.id;
      active.add(id);
      const target = sandboxTarget(sb, idx, w, h);
      upsertNode(nodes, id, target, sandboxHue(sb), 'sandbox', sb.label || id);
    });

    for (const [id, node] of nodes) {
      if (node.source === 'sandbox' && !active.has(id)) nodes.delete(id);
    }
  }, [sandboxes]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const mount = canvas.parentElement;
    if (!mount) return;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      sizeRef.current = { w, h };
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    resize();

    let lastFrame = performance.now();
    let frames = 0;
    let fpsTimer = performance.now();

    const step = (t: number) => {
      const { w, h } = sizeRef.current;
      const nodes = nodesRef.current;
      const dt = Math.min(32, t - lastFrame);
      lastFrame = t;
      frames += 1;
      if (t - fpsTimer >= 1000) {
        setFps(frames);
        frames = 0;
        fpsTimer = t;
      }

      for (const node of nodes.values()) {
        const lerp = Math.min(1, (dt / 16) * 0.22);
        node.x += (node.targetX - node.x) * lerp;
        node.y += (node.targetY - node.y) * lerp;
        node.vx *= 0.92;
        node.vy *= 0.92;
        const anchor = anchorFor(node.id, w, h);
        node.vx += (anchor.x - node.x) * 0.0015 * dt;
        node.vy += (anchor.y - node.y) * 0.0015 * dt;
        node.x += node.vx * (dt / 16);
        node.y += node.vy * (dt / 16);
        node.trail.push({ x: node.x, y: node.y });
        if (node.trail.length > trailLength) node.trail.shift();
      }

      ctx.clearRect(0, 0, w, h);
      const bg = ctx.createRadialGradient(w * 0.5, h * 0.5, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.6);
      bg.addColorStop(0, 'rgba(8,12,32,0.95)');
      bg.addColorStop(1, 'rgba(2,4,12,1)');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      for (const node of nodes.values()) {
        const trail = node.trail;
        if (trail.length > 1) {
          ctx.beginPath();
          ctx.moveTo(trail[0].x, trail[0].y);
          for (let i = 1; i < trail.length; i += 1) ctx.lineTo(trail[i].x, trail[i].y);
          ctx.strokeStyle = `hsla(${node.hue}, 80%, 60%, 0.35)`;
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        const age = t - node.lastMsgAt;
        const pulse = age < 1200 ? 1 + Math.sin((1200 - age) / 120) * 0.35 : 1;
        const r = 5 * pulse;
        const glow = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, r * 3);
        glow.addColorStop(0, `hsla(${node.hue}, 90%, 70%, 0.9)`);
        glow.addColorStop(1, `hsla(${node.hue}, 90%, 50%, 0)`);
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r * 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `hsl(${node.hue}, 85%, 65%)`;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx.fill();

        if (node.label) {
          ctx.fillStyle = 'rgba(224,242,254,0.85)';
          ctx.font = '10px ui-monospace, monospace';
          ctx.fillText(node.label.slice(0, 14), node.x + 8, node.y - 8);
        }
      }

      setAgentCount(nodes.size);
      animRef.current = requestAnimationFrame(step);
    };

    animRef.current = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(animRef.current);
      ro.disconnect();
    };
  }, [trailLength]);

  return (
    <div
      className={`relative w-full h-full min-h-[320px] overflow-hidden rounded-xl border border-white/10 ${className}`}
      data-testid="swarm-canvas"
    >
      <canvas ref={canvasRef} className="absolute inset-0" aria-label="Swarm agent position canvas" />
      <div
        className="absolute top-3 left-3 z-10 rounded-lg border border-white/10 px-3 py-2 text-[10px] font-mono text-zinc-300 space-y-0.5"
        style={{ background: 'rgba(4,4,20,0.72)', backdropFilter: 'blur(12px)' }}
        data-testid="swarm-canvas-hud"
      >
        <div className="flex items-center gap-1.5 text-cyan-300/90 font-semibold tracking-wide">
          <Radio className="w-3 h-3" />
          Swarm Canvas
        </div>
        <div className="text-zinc-500">
          {agentCount} agents · {connected ? 'live' : 'polling'} · {fps} fps
        </div>
      </div>
    </div>
  );
}
