import { runCapabilityEval } from '../src/lib/capabilityEval.ts';

const report = await runCapabilityEval({
  providerId: 'ollama-lfm',
  taskIds: ['small_web_ui'],
  agents: 3,
});
console.log(JSON.stringify(report, null, 2));
