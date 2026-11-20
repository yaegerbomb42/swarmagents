import { SynthesisDaemon } from './synthesis.ts';

async function main() {
  console.log('=====================================================');
  console.log('🚀 AGL AUTONOMOUS MULTI-AGENT SYNTHESIS SWARM RUNNER');
  console.log('Model: qwen/qwen3.8-27b on Groq Multi-Key Pool (14 keys)');
  console.log('=====================================================\n');

  const daemon = new SynthesisDaemon('qwen/qwen3.8-27b');

  console.log('Goal: Synthesize a Level 2 composite operator "square_and_add"');
  const spec = 'Compute ($a * $a) + $b using base level 0 primitives: (lvl:0:add (lvl:0:mul $a $a) $b)';

  const result = await daemon.synthesizeAndPromote(2, 'square_and_add', spec);

  console.log('\n=====================================================');
  if (result.success) {
    console.log('🎉 SUCCESS: Macro synthesized, audited, and promoted!');
    console.log(`Content Hash: sha256:${result.hash}`);
    console.log('Registry state:');
    for (const entry of daemon.getRegistry().listEntries()) {
      console.log(` - lvl:${entry.level}:${entry.op} [${entry.hash.slice(0, 16)}...] FuzzPass: ${(entry.fuzzPassRatio * 100)}%`);
    }
  } else {
    console.error('❌ Promotion failed:', result.rejectionReason);
  }
  console.log('=====================================================');
}

main().catch(err => {
  console.error('Fatal error in swarm runner:', err);
  process.exit(1);
});
