import { GroqClient } from "./groqClient.js";

async function runTest() {
  console.log("=== Testing Claude Code Mini: KeyPool & GroqClient ===");
  const client = new GroqClient();
  const pool = client.getPool();

  console.log(`Loaded ${pool.getKeyCount()} Groq API keys from monolith.`);

  const start = Date.now();
  console.log("\nSending test query to llama-3.1-8b-instant (Fast Model)...");
  
  const response = await client.chatCompletion(
    [
      { role: "system", content: "You are Claude Code Mini. Reply in exactly 1 short sentence." },
      { role: "user", content: "State your purpose and confirmation of status." }
    ],
    { model: client.fastModel, max_tokens: 50 }
  );

  const durationMs = Date.now() - start;
  console.log(`\nResponse received in ${durationMs}ms:`);
  console.log(`"${response.content}"`);
  console.log(`\nTokens used:`, response.usage);
  console.log("\nKey pool status:", pool.getStats().slice(0, 3));
}

runTest().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
