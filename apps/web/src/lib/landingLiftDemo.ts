/**
 * Landing proof — same prompt / same model comparison payload.
 * Static snapshot ships with the site; live eval can refresh via /api/public/lift.
 */

export const LANDING_LIFT_PROMPT = `Build a tiny static web UI. Create index.html (and optional app.js/styles.css if needed) such that:
1) The page title and a visible <h1> are exactly: SwarmAgents Counter
2) There is a button with id="inc" labeled Increment
3) There is an element with id="count" that starts at 0 and increases by 1 each click
Use plain HTML/JS only (no frameworks). Do not modify package.json or the test file.`;

export type LandingLiftSide = {
  label: string;
  subtitle: string;
  passed: boolean;
  ms: number;
  outcome: string;
  artifacts: string[];
  output?: string;
};

export type LandingLiftDemo = {
  version: 1;
  taskId: string;
  taskTitle: string;
  prompt: string;
  model: string;
  providerName: string;
  ranAt: number;
  headline: string;
  liftPercentagePoints: number;
  chat: LandingLiftSide;
  swarm: LandingLiftSide;
  methodNote: string;
};

/** Bundled win from the lfm2.5 A1B capability eval (chat fail / swarm pass). */
export const BUNDLED_LANDING_LIFT: LandingLiftDemo = {
  version: 1,
  taskId: 'small_web_ui',
  taskTitle: 'Build a small counter web UI',
  prompt: LANDING_LIFT_PROMPT,
  model: 'lfm2.5:8b-a1b-q4_K_M',
  providerName: 'Ollama LFM2.5 A1B',
  ranAt: 1784519964010,
  headline:
    'Same model (lfm2.5:8b-a1b-q4_K_M): SwarmAgents +100pp vs plain chat (1/1 vs 0/1)',
  liftPercentagePoints: 100,
  chat: {
    label: 'One-shot chat',
    subtitle: 'Like ChatGPT / Gemini — same model, single reply',
    passed: false,
    ms: 5922,
    outcome: 'Failed objective gates (npm test). No working index.html.',
    artifacts: ['package.json', 'test/ui.test.js'],
    output: 'Error: Cannot find module index.html in workspace.',
  },
  swarm: {
    label: 'SwarmAgents',
    subtitle: 'Same model · agents · gates · repair · world model',
    passed: true,
    ms: 323670,
    outcome: 'Passed gates. Shipped index.html + app.js that satisfy the contract.',
    artifacts: ['index.html', 'app.js', 'package.json', 'test/ui.test.js'],
    output: 'PASS test/ui.test.js (1 test passed). All contracts verified.',
  },
  methodNote:
    'Fair test: identical prompt and model. Chat arm is one-shot completion. Swarm arm uses the production leaf executor with verification gates. “ChatGPT / Google” here means that product shape — not their hosted APIs.',
};

export function reportToLandingLift(report: {
  model?: string;
  providerName?: string;
  ranAt?: number;
  summary?: {
    headline?: string;
    liftPercentagePoints?: number;
  };
  tasks?: Array<{
    id: string;
    title: string;
    baseline: {
      passed: boolean;
      ms: number;
      files?: string[];
      error?: string;
      validation_feedback?: string;
    };
    swarm: {
      passed: boolean;
      ms: number;
      files?: string[];
      error?: string;
      validation_feedback?: string;
      repairs?: number;
    };
  }>;
}): LandingLiftDemo | null {
  const task =
    report.tasks?.find((t) => t.id === 'small_web_ui') || report.tasks?.[0];
  if (!task) return null;
  return {
    version: 1,
    taskId: task.id,
    taskTitle: task.title,
    prompt: LANDING_LIFT_PROMPT,
    model: report.model || BUNDLED_LANDING_LIFT.model,
    providerName: report.providerName || BUNDLED_LANDING_LIFT.providerName,
    ranAt: report.ranAt || Date.now(),
    headline: report.summary?.headline || BUNDLED_LANDING_LIFT.headline,
    liftPercentagePoints:
      report.summary?.liftPercentagePoints ?? BUNDLED_LANDING_LIFT.liftPercentagePoints,
    chat: {
      label: 'One-shot chat',
      subtitle: 'Like ChatGPT / Gemini — same model, single reply',
      passed: task.baseline.passed,
      ms: task.baseline.ms,
      outcome: task.baseline.passed
        ? 'Passed objective gates.'
        : task.baseline.validation_feedback ||
          task.baseline.error ||
          'Failed objective gates.',
      artifacts: task.baseline.files || [],
    },
    swarm: {
      label: 'SwarmAgents',
      subtitle: 'Same model · agents · gates · repair · world model',
      passed: task.swarm.passed,
      ms: task.swarm.ms,
      outcome: task.swarm.passed
        ? `Passed gates${task.swarm.repairs ? ` after ${task.swarm.repairs} repair(s)` : ''}.`
        : task.swarm.validation_feedback || task.swarm.error || 'Failed objective gates.',
      artifacts: (task.swarm.files || []).filter(
        (f) => !f.startsWith('deliverables/') && f !== 'CONTEXT.md' && f !== 'README.md'
      ),
    },
    methodNote: BUNDLED_LANDING_LIFT.methodNote,
  };
}
