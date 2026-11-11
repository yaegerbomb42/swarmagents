import { db } from "./index";
import { 
  semanticMemory, episodicMemory, proceduralMemory, 
  neuralNodes, synapses 
} from "./schema";

export async function initializeMemory() {
  console.log("Initializing Tri-partite Memory Structure...");

  // Clear existing
  await db.delete(synapses);
  await db.delete(neuralNodes);
  await db.delete(semanticMemory);
  await db.delete(episodicMemory);
  await db.delete(proceduralMemory);

  // 1. Initialize Semantic Memory
  const sem1 = await db.insert(semanticMemory).values({
    concept: "AGI",
    definition: "Artificial General Intelligence - a system capable of understanding, learning, and applying knowledge across a wide range of tasks.",
    associations: ["System", "Learning", "Neuromorphic"],
    embeddingWeights: Array.from({length: 10}, () => Math.random()),
    weightDecay: 1.0,
  }).returning();

  const sem2 = await db.insert(semanticMemory).values({
    concept: "Neuromorphic Architecture",
    definition: "Brain-inspired computing architectures that mimic biological neural networks.",
    associations: ["AGI", "Hardware", "Synapses"],
    embeddingWeights: Array.from({length: 10}, () => Math.random()),
    weightDecay: 1.0,
  }).returning();

  // 2. Initialize Episodic Memory
  await db.insert(episodicMemory).values({
    eventDescription: "System initialization and first autonomous boot sequence.",
    context: { environment: "cloud_sandbox", mode: "bootstrap" },
    emotionValence: 0.8, // Positive alignment
    relatedSemanticIds: [sem1[0].id, sem2[0].id],
  });

  // 3. Initialize Procedural Memory
  await db.insert(proceduralMemory).values({
    skillName: "Epistemic Foraging",
    routineSteps: [
      { step: 1, action: "identify_knowledge_gap", status: "active" },
      { step: 2, action: "execute_web_search", status: "pending" },
      { step: 3, action: "extract_latent_representation", status: "pending" },
      { step: 4, action: "update_semantic_graph", status: "pending" }
    ],
    successRate: 1.0,
    executionCount: 1,
  });

  // 4. Generate Neural Topology (A sparse graph for visualizer)
  console.log("Generating Neuromorphic Topology...");
  const nodes = [];
  const numNodes = 150; // Dense enough for effect, performant enough
  
  for (let i = 0; i < numNodes; i++) {
    const type = Math.random() > 0.7 ? "semantic" : Math.random() > 0.4 ? "episodic" : "sensory";
    nodes.push({
      type,
      label: i === 0 ? "Core" : null,
      activationLevel: Math.random() * 0.5,
      firingThreshold: 0.6 + Math.random() * 0.3,
      // Random coordinates in a spherical distribution
      x: (Math.random() - 0.5) * 20,
      y: (Math.random() - 0.5) * 20,
      z: (Math.random() - 0.5) * 20,
    });
  }

  const insertedNodes = await db.insert(neuralNodes).values(nodes).returning();

  // Create Synapses (Connections)
  const synapsesToInsert = [];
  for (let i = 0; i < insertedNodes.length; i++) {
    // Connect each node to 2-4 other random nodes
    const numConnections = Math.floor(Math.random() * 3) + 2;
    for (let c = 0; c < numConnections; c++) {
      const targetIndex = Math.floor(Math.random() * insertedNodes.length);
      if (targetIndex !== i) {
        synapsesToInsert.push({
          sourceId: insertedNodes[i].id,
          targetId: insertedNodes[targetIndex].id,
          weight: Math.random(),
          isExcitatory: Math.random() > 0.2, // 80% excitatory, 20% inhibitory
        });
      }
    }
  }

  // Insert in batches if needed, but 450 should be fine
  await db.insert(synapses).values(synapsesToInsert);

  console.log("Initialization Complete.");
}

async function run() {
  await initializeMemory();
  process.exit(0);
}

if (require.main === module) {
  run().catch(console.error);
}
