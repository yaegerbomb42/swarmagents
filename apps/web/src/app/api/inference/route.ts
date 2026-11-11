/// <reference types="node" />

import { NextRequest, NextResponse } from 'next/server';
import { discoverModels, selectModelForTask, runOllamaInference, type InferenceOptions } from '@/lib/ggufInference';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ─── GET: List available models ────────────────────────────────────

export async function GET() {
  const models = discoverModels();
  return NextResponse.json({
    ok: true,
    models: models.filter((m) => m.available),
    allModels: models,
  });
}

// ─── POST: Run inference ─────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const start = Date.now();
  try {
    const body = await req.json();
    const { messages, task, temperature = 0.7, maxTokens = 2048, preferredModel, forceModel = false } = body;

    if (!messages?.length && !task) {
      return NextResponse.json({ ok: false, error: 'missing_messages_or_task' }, { status: 400 });
    }

    const msgs = messages || [{ role: 'user', content: task }];

    // Discover available models
    const allModels = discoverModels();
    const available = allModels.filter((m) => m.available);

    if (!available.length) {
      return NextResponse.json({
        ok: false,
        error: 'No GGUF models available. Check ~/ai/models/ for .gguf files.',
        models: allModels,
      }, { status: 503 });
    }

    // Select model
    let selectedModel = available[0];
    let routingReason = 'Default fallback';

    if (forceModel && preferredModel) {
      const forced = available.find((m) => m.id === preferredModel);
      if (forced) {
        selectedModel = forced;
        routingReason = 'User forced model selection';
      }
    } else {
      const taskText = msgs.map((m: any) => m.content).join(' ');
      const routing = selectModelForTask(taskText, allModels);
      if (routing.model) {
        selectedModel = routing.model;
        routingReason = routing.reason;
      }
    }

    // Try Ollama first (most reliable), then fall back to yaeger_server.py
    let result = await runOllamaInference(selectedModel.id, msgs, { temperature, maxTokens });

    // If Ollama fails, try yaeger-specific model names
    if (result.error && selectedModel.id.startsWith('yaeger')) {
      const ollamaName = selectedModel.id === 'yaeger-1b' ? 'yaeger:1b'
        : selectedModel.id === 'yaeger-option_a' ? 'yaeger:1b'
        : selectedModel.id === 'yaeger-16.9b-q8' ? 'swarmagent-core-16.9b'
        : selectedModel.id === 'yaeger-16.9b-q4' ? 'swarmagent-router-16.9b'
        : selectedModel.id;
      result = await runOllamaInference(ollamaName, msgs, { temperature, maxTokens });
    }

    // If all inference fails, return routing info + error
    if (result.error) {
      return NextResponse.json({
        ok: false,
        error: result.error,
        routing: {
          selected_model: selectedModel.id,
          selected_name: selectedModel.name,
          confidence: 1,
          reason: routingReason,
          available_models: available.map((m) => ({ id: m.id, name: m.name, sizeGB: m.sizeGB })),
        },
        latency_ms: Date.now() - start,
      }, { status: 503 });
    }

    return NextResponse.json({
      ok: true,
      routing: {
        selected_model: selectedModel.id,
        selected_name: selectedModel.name,
        parameters: selectedModel.parameters,
        quant: selectedModel.quant,
        confidence: 1,
        reason: routingReason,
      },
      result: {
        content: result.content,
        tokens_used: result.tokensUsed,
      },
      latency_ms: result.latencyMs,
    });

  } catch (e: any) {
    return NextResponse.json({
      ok: false,
      error: e.message,
      latency_ms: Date.now() - start,
    }, { status: 500 });
  }
}
