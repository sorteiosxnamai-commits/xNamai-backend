/**
 * URL pública do backend para webhooks Mercado Pago.
 * Nunca usar PUBLIC_URL (pode apontar para o frontend Vercel).
 */
export function getBackendPublicUrl(req) {
  const envUrl =
    process.env.MP_WEBHOOK_BASE_URL ||
    process.env.BACKEND_PUBLIC_URL ||
    process.env.PUBLIC_BACKEND_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    process.env.API_PUBLIC_URL ||
    "";

  if (envUrl) return String(envUrl).replace(/\/+$/, "");

  const protoRaw = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const proto = String(protoRaw).split(",")[0].trim() || "https";
  const host = req.get("host");
  let baseUrl = `${proto}://${host}`.replace(/\/+$/, "");
  if (process.env.NODE_ENV === "production" && !baseUrl.startsWith("https://")) {
    baseUrl = baseUrl.replace(/^http:\/\//, "https://");
  }
  return baseUrl;
}
