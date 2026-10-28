import { UTILIZATION_TARGET_PERCENT, type AccountUtilizationPlan } from "./capacity-planner";

const esc = (value: string): string => value.replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]!));

function actionLabel(plan: AccountUtilizationPlan): string {
  if (plan.action === "more") return plan.confidence === "early" ? "Shift away" : "More capacity";
  if (plan.action === "less") return "Less capacity";
  if (plan.action === "keep") return "Keep";
  if (plan.action === "rebalance") return plan.confidence === "early" ? "Shift here" : "Rebalance";
  return "Needs data";
}

// Identity, current usage and reset already appear above this disclosure.
export function renderCapacityPlan(plan: AccountUtilizationPlan): string {
  const window = plan.window;
  const projected = window?.projectedUsedPercent === undefined
    ? window ? "Awaiting live use" : plan.currentValue ?? "90% target"
    : `${Math.round(window.projectedUsedPercent)}% ${plan.confidence === "early" ? "live projection" : "projected"}`;
  const required = window?.requiredRate === undefined
    ? plan.paceValue
    : window.remainingToTargetPercent <= 0
      ? "Target banked"
      : `${window.requiredRate.toFixed(window.requiredRate < 10 ? 1 : 0)} pts / ${window.rateUnit}`;
  return `<details class="capacity-plan action-${plan.action}" data-utilization-key="${esc(`${plan.provider}:${plan.account.toLowerCase()}`)}">
    <summary><span class="plan-action">${actionLabel(plan)}</span><span class="plan-projection">${esc(projected)}</span></summary>
    <div class="plan-body"><div class="plan-target">${esc(plan.resource)} · target ${UTILIZATION_TARGET_PERCENT}%${required ? `<strong>${esc(required)}</strong>` : ""}</div><p>${esc(plan.detail)}</p></div>
  </details>`;
}
