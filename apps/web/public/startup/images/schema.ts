import { pgTable, text, timestamp, uuid, jsonb, real, integer, boolean } from "drizzle-orm/pg-core";

// 1. SEMANTIC MEMORY
// Stores facts, concepts, and global knowledge graphs.
export const semanticMemory = pgTable("semantic_memory", {
  id: uuid("id").primaryKey().defaultRandom(),
  concept: text("concept").notNull(),
  definition: text("definition").notNull(),
  associations: jsonb("associations").default([]).notNull(), // Array of related concept IDs
  embeddingWeights: jsonb("embedding_weights").default([]).notNull(), // Simulated latent representation
  weightDecay: real("weight_decay").default(1.0).notNull(), // Simulates forgetting
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// 2. EPISODIC MEMORY
// Stores experiences with strict temporal timestamps and relational context.
export const episodicMemory = pgTable("episodic_memory", {
  id: uuid("id").primaryKey().defaultRandom(),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
  eventDescription: text("event_description").notNull(),
  context: jsonb("context").default({}).notNull(),
  emotionValence: real("emotion_valence").default(0.0).notNull(), // -1.0 to 1.0
  relatedSemanticIds: jsonb("related_semantic_ids").default([]).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// 3. PROCEDURAL MEMORY
// Stores skill libraries, learned tool routines, and action execution.
export const proceduralMemory = pgTable("procedural_memory", {
  id: uuid("id").primaryKey().defaultRandom(),
  skillName: text("skill_name").notNull(),
  routineSteps: jsonb("routine_steps").default([]).notNull(), // Directed acyclic graph steps
  successRate: real("success_rate").default(0.0).notNull(),
  executionCount: integer("execution_count").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// NEUROMORPHIC TOPOLOGY
// Simulated neurons for visualization and graph-state persistence
export const neuralNodes = pgTable("neural_nodes", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type").notNull(), // 'semantic', 'episodic', 'procedural', 'sensory', 'motor'
  label: text("label"), // Concept or skill name
  activationLevel: real("activation_level").default(0.0).notNull(),
  firingThreshold: real("firing_threshold").default(0.5).notNull(),
  x: real("x").notNull(), // 3D coordinates for spatial visualization
  y: real("y").notNull(),
  z: real("z").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const synapses = pgTable("synapses", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceId: uuid("source_id").references(() => neuralNodes.id).notNull(),
  targetId: uuid("target_id").references(() => neuralNodes.id).notNull(),
  weight: real("weight").default(0.5).notNull(),
  isExcitatory: boolean("is_excitatory").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
