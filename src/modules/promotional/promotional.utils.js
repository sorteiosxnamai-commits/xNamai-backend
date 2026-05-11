export function formatPromotionalNumber(n) {
  const value = Number(n);
  if (value < 100) return String(value).padStart(2, "0");
  return String(value);
}

export function normalizeDrawStatus(status) {
  const value = String(status || "draft").trim().toLowerCase();
  if (["draft", "active", "inactive", "closed"].includes(value)) return value;
  return "draft";
}

export function normalizeNumberStatus(status) {
  const value = String(status || "available").trim().toLowerCase();
  if (["available", "reserved", "sold", "blocked"].includes(value)) return value;
  return "available";
}
