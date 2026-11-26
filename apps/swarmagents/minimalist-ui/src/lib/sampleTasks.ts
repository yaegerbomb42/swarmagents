/**
 * sampleTasks — the canned first-run sample tasks shown on the "Try it"
 * step of first-run onboarding (and replayed from Settings).
 *
 * Each task is sized for 1–3 minutes on the user's VM and ends with a
 * visible deliverable file in /workspace, so a new user reaches "I watched
 * it do something" in one run. The first sample deliberately starts with the
 * exact phrase the fake-VM e2e driver uses to select its recorded
 * "write a file and run a script" transcript, so the local e2e suite can
 * drive it end to end without a live model provider.
 */

export interface SampleTask {
  id: string;
  /** Short name on the card. */
  title: string;
  /** The full prompt dispatched through /api/runtime/tasks. */
  prompt: string;
  /** One line on the card: what the agent will do. */
  blurb: string;
  /** Expected run time, shown for honesty. */
  minutes: string;
  /** The deliverable the run leaves in the workspace. */
  deliverable: string;
}

export const SAMPLE_TASKS: readonly SampleTask[] = [
  {
    id: "primes",
    title: "Print the first 20 primes",
    prompt:
      "Create a file and run a script that prints the first 20 prime numbers, one per line, and saves the output to /workspace/primes.txt. Show me the primes.txt file when you are done.",
    blurb: "Writes a Python script, runs it, saves the output.",
    minutes: "1–2 min",
    deliverable: "primes.txt",
  },
  {
    id: "bar-chart",
    title: "Make a bar chart PNG",
    prompt:
      "Create a small CSV in /workspace with a few rows of sample data, then write and run a Python script that renders it as a bar chart and saves it to /workspace/chart.png. Show me the PNG when you are done.",
    blurb: "Generates data, plots a chart, saves a PNG.",
    minutes: "2–3 min",
    deliverable: "chart.png",
  },
  {
    id: "pdf-memo",
    title: "Create a one-page PDF memo",
    prompt:
      "Use LibreOffice (soffice --headless) to create a one-page PDF memo in /workspace titled \"Memo\" with a few lines of text, and confirm the file exists. Show me the PDF when you are done.",
    blurb: "Composes a document and exports it to PDF.",
    minutes: "2–3 min",
    deliverable: "memo.pdf",
  },
];

export function sampleTaskById(id: string): SampleTask | undefined {
  return SAMPLE_TASKS.find((task) => task.id === id);
}
