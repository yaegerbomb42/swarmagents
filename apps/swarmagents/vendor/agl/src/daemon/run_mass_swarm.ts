import { MassSwarmSynthesizer } from './mass_swarm.ts';

async function main() {
  const synth = new MassSwarmSynthesizer('qwen/qwen3.8-27b');
  await synth.runFullSwarm();
}

main().catch(err => {
  console.error('Mass Swarm Runner encountered fatal exception:', err);
  process.exit(1);
});
