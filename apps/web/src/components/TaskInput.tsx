"use client";

import React, { useState } from "react";
import { DeliverableType } from "@/types/decomposition";
import TimeBudgetControl, {
  timeBudgetFromHours,
  type TimeBudgetValue,
} from "@/components/TimeBudgetControl";

interface TaskInputProps {
  onSubmit: (description: string, timeBudgetHours: number, deliverableType: DeliverableType) => void;
  isProcessing?: boolean;
  layout?: "fixed" | "embedded";
}

export default function TaskInput({
  onSubmit,
  isProcessing = false,
  layout = "fixed",
}: TaskInputProps) {
  const [description, setDescription] = useState("");
  const [timeBudget, setTimeBudget] = useState<TimeBudgetValue>(() => timeBudgetFromHours(1));
  const [deliverableType, setDeliverableType] = useState<DeliverableType>(DeliverableType.DOCUMENT);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (description.trim() && !isProcessing) {
      onSubmit(description.trim(), timeBudget.minutes / 60, deliverableType);
    }
  };

  const containerClass = layout === "fixed"
    ? "neon-input-bar fixed bottom-0 left-0 right-0 p-6 z-50"
    : "neon-input-bar rounded-2xl p-5";

  return (
    <div className={containerClass}>
      <form onSubmit={handleSubmit} className="max-w-6xl mx-auto">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col lg:flex-row gap-4 lg:items-start">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the huge project: product goals, target users, constraints, output format, and quality bar..."
              className="neon-input flex-1 px-4 py-3 rounded-lg text-sm font-mono min-h-[96px] resize-y"
              disabled={isProcessing}
            />

            <div className="flex flex-col sm:flex-row lg:flex-col gap-3 lg:w-56">
              <select
                value={deliverableType}
                onChange={(e) => setDeliverableType(e.target.value as DeliverableType)}
                className="neon-input px-4 py-3 rounded-lg text-sm font-mono"
                disabled={isProcessing}
              >
                <option value={DeliverableType.DOCUMENT}>Document</option>
                <option value={DeliverableType.CODEBASE}>Codebase</option>
                <option value={DeliverableType.WEBSITE}>Website</option>
                <option value={DeliverableType.PDF}>PDF</option>
                <option value={DeliverableType.DATASET}>Dataset</option>
                <option value={DeliverableType.MODEL}>Model</option>
                <option value={DeliverableType.API}>API</option>
                <option value={DeliverableType.OTHER}>Other</option>
              </select>

              <button
                type="submit"
                disabled={!description.trim() || isProcessing}
                className="neon-button px-8 py-3 rounded-lg text-sm font-mono whitespace-nowrap"
              >
                {isProcessing ? (
                  <span className="flex items-center gap-2">
                    <span className="neon-spinner w-4 h-4"></span>
                    Auto-decomposing…
                  </span>
                ) : (
                  "Create Tree"
                )}
              </button>
            </div>
          </div>

          <TimeBudgetControl
            value={timeBudget}
            onChange={setTimeBudget}
            disabled={isProcessing}
          />

          <div className="text-xs font-mono opacity-60" style={{ color: "var(--neon-cyan)" }}>
            DeepSeek auto-deepens until every leaf fits a small local worker and the tree matches your {timeBudget.label} wall-clock budget.
          </div>
        </div>
      </form>
    </div>
  );
}
