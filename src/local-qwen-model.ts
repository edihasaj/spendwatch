// The self-hosted Qwen model aliases. Kept free of imports so the aggregate can use it without a cycle.
export const LOCAL_QWEN_ACCOUNT = "Local Qwen";

export function isLocalQwenModel(model: unknown): boolean {
  if (typeof model !== "string") return false;
  const normalized = model.trim().toLowerCase().replace(/^(?:codex|claude)\//, "");
  return normalized === "qwen3.8-flash-next" || normalized === "qwen/qwen3.8-flash-next";
}
