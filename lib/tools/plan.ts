import type { PlanItem } from "../types";
import type { Tool } from "./types";

export const plan: Tool = {
  spec: {
    name: "plan",
    description:
      "Set or update the visible task plan (shown live to the user). Use for multi-step work: list steps, mark exactly one active, mark done as you go. Skip for trivial tasks.",
    schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "object", properties: { text: { type: "string" }, status: { type: "string", enum: ["pending", "active", "done"] } }, required: ["text", "status"] },
        },
      },
      required: ["items"],
    },
  },
  async run(input, ctx) {
    const items = (input.items as PlanItem[]) ?? [];
    ctx.setPlan(items);
    return { content: `Plan updated: ${items.filter((i) => i.status === "done").length}/${items.length} done.` };
  },
};
