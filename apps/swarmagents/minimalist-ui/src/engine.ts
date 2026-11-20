import type { ActiveRole, Attachment, ProviderConfig } from './data';

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

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const id = setTimeout(res, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(id);
      rej(new DOMException('aborted', 'AbortError'));
    });
  });

const estTokens = (s: string) => Math.max(1, Math.round(s.length / 4));

function attachmentContext(atts: Attachment[]) {
  if (!atts.length) return '';
  return (
    '\n\nAttachments:\n' +
    atts
      .map((a) => {
        let s = `- ${a.name} (${a.kind}, ${(a.size / 1024).toFixed(1)} KB)`;
        if (a.text) s += `\n\`\`\`\n${a.text.slice(0, 6000)}\n\`\`\``;
        return s;
      })
      .join('\n')
  );
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

/* ---------- Simulation ---------- */

function keywords(s: string) {
  const stop = new Set('the a an and or of to in on for with is are be this that it i you me my we can how what why make build please want just'.split(' '));
  const w = s.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [];
  return [...new Set(w.filter((x) => !stop.has(x)))].slice(0, 5);
}

function simulate(role: ActiveRole, input: string, atts: Attachment[]) {
  const k = keywords(input);
  const topic = k.length ? k.join(', ') : 'the request';
  const media = atts.length
    ? ` Inspected ${atts.length} attachment${atts.length > 1 ? 's' : ''} (${atts.map((a) => a.kind).join(', ')}).`
    : '';
  const t: Record<string, string> = {
    planner: `Plan for ${topic}:\n1. Clarify scope and constraints\n2. Gather context on ${k[0] ?? 'domain'}\n3. Draft solution\n4. Review + test\n5. Synthesize final response.${media}`,
    researcher: `Key context on ${topic}: established approaches exist; main unknowns are scale, audience and constraints.${media} Recommend validating assumptions early.`,
    coder: `Implementation sketch:\n\`\`\`ts\nexport async function run(input: string) {\n  const ctx = await gather(input);\n  return solve(ctx, ${JSON.stringify(k[0] ?? 'task')});\n}\n\`\`\``,
    critic: `Risks: ambiguous requirements around ${k[0] ?? 'scope'}, missing edge cases for empty input, and unverified assumptions. Suggest explicit acceptance criteria.`,
    writer: `Draft: A focused approach to ${topic} that keeps things simple, clear and easy to iterate on.`,
    analyst: `Comparing 3 options for ${topic}: A (fast, 70% coverage), B (balanced, 85%), C (thorough, 95%, 2× cost). B offers best value.`,
    designer: `Direction: minimal surface, generous whitespace, one primary action. Glass layers with subtle depth for ${k[0] ?? 'the interface'}.`,
    vision: atts.some((a) => a.kind === 'image' || a.kind === 'video')
      ? `Media analysis: ${atts.filter((a) => a.kind === 'image' || a.kind === 'video').map((a) => a.name).join(', ')} — composition parsed, salient regions extracted, no anomalies.`
      : 'No visual media attached — standing by.',
    tester: `Test cases: happy path for ${k[0] ?? 'input'}, empty input, oversized payload, malformed attachment, concurrent runs.`,
    security: `Audit: no secrets in payload, attachments sandboxed, recommend rate-limiting and input sanitization.`,
    summarizer: `TL;DR — ${topic}: plan drafted, risks noted, balanced option recommended.`,
    translator: `Localization: strings are short and neutral; watch date/number formats and RTL layouts.`,
    data: `Schema: { id, input, attachments[], agentRuns[{role, tokens, latency}] } streamed through an event log.`,
    pm: `Goal alignment: ship the smallest valuable slice for ${topic} first, measure, then expand.`,
    synth: `Final answer on ${topic}: following the plan, the balanced approach is recommended. Key risks are addressed with tests and security checks. Next step: implement the sketch and validate.`,
  };
  return t[role.id] ?? `${role.name} processed ${topic}.${media}`;
}

/* ---------- Orchestration ---------- */

export async function runAgents(opts: {
  roles: ActiveRole[];
  providers: ProviderConfig[];
  input: string;
  attachments: Attachment[];
  signal: AbortSignal;
  update: (uid: string, patch: Partial<AgentState> | ((s: AgentState) => Partial<AgentState>)) => void;
  log: (e: Omit<LogEvent, 't'>) => void;
  onError?: (agent: string, err: unknown) => void;
}) {
  const { roles, providers, input, attachments, signal, update, log, onError } = opts;
  const outputs: Record<string, string> = {};

  const runOne = async (role: ActiveRole, priorIds: string[]) => {
    const prov = providers.find((p) => p.uid === role.providerUid && p.enabled);
    const model = prov ? `${prov.name} · ${prov.model}` : 'simulated';
    const prior = priorIds
      .map((id) => roles.find((r) => r.uid === id))
      .filter(Boolean)
      .map((r) => `[${r!.name}]\n${outputs[r!.uid] ?? ''}`)
      .join('\n\n');
    const userMsg = `${input}${attachmentContext(attachments)}${prior ? `\n\nPrior agent outputs:\n${prior}` : ''}`;
    const inTokens = estTokens(role.prompt + userMsg);

    update(role.uid, { status: 'thinking', start: performance.now(), model, inTokens, output: '', tokens: 0, error: undefined });
    log({ agent: role.name, hue: role.hue, msg: `started → ${model}` });

    let text = '';
    let realOut: number | undefined;
    try {
      if (prov) {
        const r = await callProvider(prov, role.prompt + ' Be concise.', userMsg, attachments, signal);
        text = r.text || '(empty response)';
        realOut = r.outTok;
        if (r.inTok) update(role.uid, { inTokens: r.inTok });
      } else {
        await sleep(350 + Math.random() * 900, signal);
        text = simulate(role, input, attachments);
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      const msg = (e as Error).message || 'request failed';
      update(role.uid, { status: 'error', error: msg, end: performance.now() });
      log({ agent: role.name, hue: role.hue, msg: `error: ${msg}` });
      // Surface provider/network failures to the UI toast layer (t14r).
      onError?.(role.name, e);
      outputs[role.uid] = '';
      return;
    }

    update(role.uid, { status: 'streaming', firstToken: performance.now() });
    log({ agent: role.name, hue: role.hue, msg: 'first token' });

    const chunks = text.match(/\S+\s*|\s+/g) ?? [text];
    const delay = prov ? 8 : 22;
    let acc = '';
    for (const c of chunks) {
      acc += c;
      const tk = estTokens(acc);
      update(role.uid, { output: acc, tokens: tk });
      await sleep(delay + Math.random() * delay, signal);
    }
    outputs[role.uid] = text;
    update(role.uid, { status: 'done', end: performance.now(), tokens: realOut ?? estTokens(text) });
    log({ agent: role.name, hue: role.hue, msg: `done · ${realOut ?? estTokens(text)} tok` });
  };

  if (!roles.length) return outputs;
  const first = roles[0];
  const last = roles.length > 2 ? roles[roles.length - 1] : undefined;
  const middle = roles.slice(1, last ? -1 : undefined);

  await runOne(first, []);
  await Promise.all(middle.map((r) => runOne(r, [first.uid])));
  if (last) await runOne(last, roles.slice(0, -1).map((r) => r.uid));
  return outputs;
}
