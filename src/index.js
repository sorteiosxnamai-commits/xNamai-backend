// backend/src/index.js
import "dotenv/config";

process.on("uncaughtException", (err) => {
  console.error("[BOOT_UNCAUGHT_EXCEPTION]", {
    message: err?.message,
    stack: err?.stack,
    name: err?.name,
  });
});

process.on("unhandledRejection", (reason) => {
  console.error("[BOOT_UNHANDLED_REJECTION]", {
    message: reason?.message || String(reason),
    stack: reason?.stack,
    name: reason?.name,
  });
});

import dns from "dns";
try { dns.setDefaultResultOrder("ipv4first"); } catch {}

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

import authRoutes from "./routes/auth.js";
import numbersRoutes from "./routes/numbers.js";
import reservationsRoutes from "./routes/reservations.js";
import paymentsRoutes from "./routes/payments.js";
import paymentsVindiRoutes from "./routes/payments_vindi.js";
import meRoutes from "./routes/me.js";
import drawsRoutes from "./routes/draws.js";
import drawsExtRoutes from "./routes/draws_ext.js";
import promotionalDirectRouter from "./modules/promotional/promotional.direct.routes.js";
import promotionalPublicRouter from "./modules/promotional/promotional.public.routes.js";
import promotionalAdminRouter from "./modules/promotional/promotional.admin.routes.js";
import adminDrawsRouter from "./routes/admin_draws.js";
import adminClientsRouter from "./routes/admin_clients.js";
import adminWinnersRouter from "./routes/admin_winners.js";
import adminDashboardRouter from "./routes/admin_dashboard.js";
import configRouter from "./routes/config.js";
import adminConfigRouter from "./routes/admin_config.js";
import adminRoutes from "./routes/admin.js";
import purchaseLimitRouter from "./routes/purchase_limit.js";
import couponsRouter from "./routes/coupons.js";
import trayRouter from "./routes/tray.js";
import adminUsersRouter from "./routes/adminUsers.js";
import autopayRouter from "./routes/autopay.js";
import autopayVindiRouter from "./routes/autopay_vindi.js";
import meDraws from "./routes/me_draws.js";
import autopayRunnerRoute from "./routes/autopay_runner.js";
import adminAnalyticsRouter from "./routes/analytics.js";
import { mercadoPagoRouter, mercadoPagoWebhookHandler } from "./routes/mercadoPago.js";
import { query, getPool } from "./db.js";
import { ensureSchema } from "./seed.js";
import { ensureMainRaffleCompat } from "./services/mainRaffleCompat.js";
import { ensureAppConfig } from "./services/config.js";
import { validateTrayConfigAtStartup } from "./services/trayConfig.js";

const app = express();
app.set("trust proxy", 1);

const PORT = Number(process.env.PORT || 4000);

const corsRaw =
  process.env.CORS_ORIGIN ||
  process.env.CORS_ORIGINS ||
  process.env.FRONTEND_URL ||
  "";

const allowList = corsRaw.split(",").map((s) => s.trim()).filter(Boolean);

function warnOptionalEnv() {
  const mp = String(process.env.MP_ACCESS_TOKEN || process.env.MERCADOPAGO_ACCESS_TOKEN || "").trim();
  if (!mp) {
    console.warn("[BOOT_WARN] MP_ACCESS_TOKEN not configured. PIX routes will fail until configured.");
  }

  const vindiKey = String(process.env.VINDI_API_KEY || "").trim();
  const vindiPub = String(process.env.VINDI_PUBLIC_KEY || "").trim();
  if (!vindiKey || !vindiPub) {
    console.warn("[BOOT_WARN] Vindi not configured. Autopay disabled.");
  }

  try { validateTrayConfigAtStartup(); } catch (e) {
    console.warn("[BOOT_WARN] Tray config:", e?.message || e);
  }
}

function assertRequiredBootEnv() {
  const dbUrl =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL;
  if (!String(dbUrl || "").trim()) {
    throw new Error("DATABASE_URL (ou POSTGRES_URL) é obrigatória para iniciar o backend.");
  }

  const jwt =
    process.env.JWT_SECRET ||
    process.env.JWT_SECRET_KEY ||
    process.env.SUPABASE_JWT_SECRET;
  const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  if (isProd && !String(jwt || "").trim()) {
    throw new Error("JWT_SECRET é obrigatório em produção.");
  }
  if (!String(jwt || "").trim()) {
    console.warn("[BOOT_WARN] JWT_SECRET not set. Using dev fallback in auth middleware.");
  }
}

setInterval(() => {
  query("SELECT 1").catch((e) =>
    console.warn("[health] db ping failed:", e.code || e.message)
  );
}, 60_000);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowList.includes(origin)) return callback(null, true);
      console.warn("[cors] blocked origin:", origin);
      return callback(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    optionsSuccessStatus: 204,
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Reconcile apenas em POST /api/payments/reconcile, webhook MP e GET /api/payments/:id/status

app.use("/api/auth", authRoutes);
app.use("/api/numbers", numbersRoutes);
app.use("/api/reservations", reservationsRoutes);
app.use("/api/payments", paymentsRoutes);
app.use("/api/payments", paymentsVindiRoutes);
app.use("/api/orders", paymentsRoutes);
app.use("/api/participations", paymentsRoutes);
app.use("/api/me", meRoutes);
app.use("/api/draws", drawsRoutes);
app.use("/api/draws-ext", drawsExtRoutes);
app.use("/api/promotional/admin", promotionalAdminRouter);
app.use("/api/promotional", promotionalDirectRouter);
app.use("/api/promotional", promotionalPublicRouter);
app.use("/api/admin/draws", adminDrawsRouter);
app.use("/api/admin/clients", adminClientsRouter);
app.use("/api/admin/winners", adminWinnersRouter);
app.use("/api/admin/dashboard", adminDashboardRouter);
app.use("/api/config", configRouter);
app.use("/api/admin/config", adminConfigRouter);
app.use("/api/admin/analytics", adminAnalyticsRouter);
app.use("/api/admin/users", adminUsersRouter);
app.use("/api/admin/autopay", autopayRunnerRoute);
app.use("/api/admin", adminRoutes);
app.use("/api/purchase-limit", purchaseLimitRouter);
app.use("/api/coupons", couponsRouter);
app.use("/tray", trayRouter);
app.use("/api/tray", trayRouter);
app.use("/api", autopayRouter);
app.use("/api/autopay", autopayVindiRouter);
app.use("/api/me/draws", meDraws);
app.use("/api/mercadopago", mercadoPagoRouter);
app.use("/api/payments/mercadopago", mercadoPagoRouter);
app.post("/api/payments/webhook/mercadopago", mercadoPagoWebhookHandler);

app.use((req, res) => {
  res.status(404).json({ error: "not_found", path: req.originalUrl });
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error("[express] erro não tratado:", {
    path: req.originalUrl,
    method: req.method,
    message: err?.message || String(err),
    code: err?.code,
  });
  const status = err?.status || err?.statusCode || 500;
  res.status(status).json({
    ok: false,
    code: err?.code || "INTERNAL_ERROR",
    error_message: err?.message || "Erro interno do servidor",
  });
});

async function startServer() {
  console.log("[BOOT] Starting Xnamai backend...", {
    nodeEnv: process.env.NODE_ENV,
    port: PORT,
  });

  assertRequiredBootEnv();
  warnOptionalEnv();

  await ensureMainRaffleCompat();
  await ensureSchema();
  await ensureAppConfig();

  const pool = await getPool();
  await pool.query("SELECT 1");
  console.log("[BOOT] Database warmup ok");

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[BOOT] Xnamai backend listening on 0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  const message =
    err?.message ||
    (Array.isArray(err?.errors) ? err.errors.map((e) => e?.message).filter(Boolean).join("; ") : "") ||
    String(err);
  console.error("[BOOT_FATAL]", {
    message,
    stack: err?.stack,
    name: err?.name,
    code: err?.code,
  });
  process.exit(1);
});
