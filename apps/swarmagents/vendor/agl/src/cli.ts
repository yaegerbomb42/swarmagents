#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Parser } from './parser.js';
import { Evaluator } from './runtime/evaluator.js';
import { ExecutionContext } from './runtime/context.js';
import { DistributedRegistry } from './ledger/registry.js';

async function runCLI() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(`AGL (Agentic Grammar Language) Runtime v1.0.0-IMMUTABLE
Usage:
  agl-run <file.agl>
  agl-run -e "(lvl:0:add 10 20)"
`);
    process.exit(0);
  }

  let code = '';
  if (args[0] === '-e' && args[1]) {
    code = args[1];
  } else {
    try {
      code = readFileSync(args[0], 'utf-8');
    } catch (e: any) {
      console.error(`Error reading ${args[0]}:`, e.message);
      process.exit(1);
    }
  }

  // Load registry
  const registry = new DistributedRegistry();
  try {
    const rawLedger = readFileSync('/Users/dev/swarmagents/packages/agl/agl_ledger.json', 'utf-8');
    const items = JSON.parse(rawLedger);
    for (const item of items) {
      const ast = new Parser(item.rawCode).parse();
      registry.register({
        hash: item.hash,
        level: item.level,
        op: item.op,
        ast,
        creatorAgent: item.creatorAgent,
        fuzzPassRatio: item.fuzzPassRatio,
        timestamp: item.timestamp,
        metadata: item
      });
    }
  } catch {
    // optional
  }

  const parser = new Parser(code);
  const ast = parser.parse();
  const evaluator = new Evaluator(registry.toMap());
  const ctx = new ExecutionContext();

  const start = performance.now();
  const result = await evaluator.evaluate(ast, ctx);
  const duration = (performance.now() - start).toFixed(3);

  console.log(JSON.stringify({
    status: 'SUCCESS',
    hash: ast.hash,
    executionTimeMs: Number(duration),
    output: result
  }, null, 2));
}

runCLI().catch(err => {
  console.error(JSON.stringify({
    status: 'ERROR',
    error: err.message,
    stack: err.stack
  }, null, 2));
  process.exit(1);
});
