import type { Attachment, ProviderConfig } from './data';

export type AgentStatus = 'idle' | 'queued' | 'thinking' | 'streaming' | 'done' | 'error';

export interface AgentState {
  status: AgentStatus;
  output: string;
  tokens: number;
  inTokens: number;
  start?: number;
  firstToken?: number;
  end?: number;
  error?: string;
  model: string;
}

export interface LogEvent {
  t: number;
  agent: string;
  hue: number;
  msg: string;
}

export async function callProvider(
  p: ProviderConfig,
  system: string,
  user: string,
  atts: Attachment[],
  signal: AbortSignal,
): Promise<{ text: string; inTok?: number; outTok?: number }> {
  const images = atts.filter((a) => a.kind === 'image' && a.dataUrl);
  const base = p.baseUrl.replace(/\/$/, '');

  if (p.format === 'anthropic') {
    const content: unknown[] = images.map((i) => {
      const [meta, data] = i.dataUrl!.split(',');
      return { type: 'image', source: { type: 'base64', media_type: meta.slice(5, meta.indexOf(';')), data } };
    });
    content.push({ type: 'text', text: user });
    const r = await fetch(`${base}/messages`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': p.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model: p.model, max_tokens: 700, system, messages: [{ role: 'user', content }] }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message || r.statusText);
    return {
      text: j.content?.map((c: { text?: string }) => c.text ?? '').join('') ?? '',
      inTok: j.usage?.input_tokens,
      outTok: j.usage?.output_tokens,
    };
  }

  if (p.format === 'gemini') {
    const parts: unknown[] = images.map((i) => {
      const [meta, data] = i.dataUrl!.split(',');
      return { inline_data: { mime_type: meta.slice(5, meta.indexOf(';')), data } };
    });
    parts.push({ text: user });
    const r = await fetch(`${base}/models/${p.model}:generateContent?key=${encodeURIComponent(p.apiKey)}`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ system_instruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts }] }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message || r.statusText);
    return {
      text: j.candidates?.[0]?.content?.parts?.map((x: { text?: string }) => x.text ?? '').join('') ?? '',
      inTok: j.usageMetadata?.promptTokenCount,
      outTok: j.usageMetadata?.candidatesTokenCount,
    };
  }

  if (p.format === 'cohere') {
    const r = await fetch(`${base}/chat`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify({
        model: p.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.message || r.statusText);
    return {
      text: j.message?.content?.map((c: { text?: string }) => c.text ?? '').join('') ?? '',
      inTok: j.usage?.tokens?.input_tokens,
      outTok: j.usage?.tokens?.output_tokens,
    };
  }

  // OpenAI-compatible
  const userContent = images.length
    ? [{ type: 'text', text: user }, ...images.map((i) => ({ type: 'image_url', image_url: { url: i.dataUrl } }))]
    : user;
  const isAzure = base.includes('.azure.com');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (p.apiKey) {
    if (isAzure) headers['api-key'] = p.apiKey;
    else headers.authorization = `Bearer ${p.apiKey}`;
  }
  const url = `${base}/chat/completions${isAzure && !base.includes('api-version') ? '?api-version=2024-06-01' : ''}`;
  const r = await fetch(url, {
    method: 'POST',
    signal,
    headers,
    body: JSON.stringify({
      model: p.model,
      max_tokens: 700,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || r.statusText);
  return { text: j.choices?.[0]?.message?.content ?? '', inTok: j.usage?.prompt_tokens, outTok: j.usage?.completion_tokens };
}


/* ---------- Provider key test ---------- */

/* callProvider above is used by Settings to test a provider key ("ping").
   There is no simulated run engine in this file: a failed dispatch is an
   error, never a local fallback that could look like completed VM work. */
