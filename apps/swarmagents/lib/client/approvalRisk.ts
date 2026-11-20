import type { RiskLevel } from "../harness/risk";

export type ApprovalRiskTier = "low" | "review" | "high";

export interface ApprovalRiskSegments {
  tier: ApprovalRiskTier;
  /** 1..3 segments filled in the risk meter. */
  segments: 1 | 2 | 3;
  label: string;
}

/**
 * Map a harness risk decision to the 3-segment meter shown on approval cards.
 * Hydrogen classifier levels: allow -> low (1), ask -> review (2), deny -> high (3).
 */
export function approvalRiskSegments(level: RiskLevel): ApprovalRiskSegments {
  switch (level) {
    case "allow":
      return { tier: "low", segments: 1, label: "Low risk" };
    case "ask":
      return { tier: "review", segments: 2, label: "Review" };
    case "deny":
      return { tier: "high", segments: 3, label: "High risk" };
    default: {
      const exhaustive: never = level;
      return exhaustive;
    }
  }
}
