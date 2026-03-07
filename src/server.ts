import "dotenv/config";
import express, { type Request, type Response } from "express";
import bodyParser from "body-parser";
import { Pool } from "pg";
import { randomUUID } from "crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set in environment (.env)");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const app = express();
app.use(bodyParser.json());

/**
 * Health check – sanity for StaffordOS Command Center
 */
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "staffordos-core" });
});

/**
 * POST /abando/merchant
 * Upsert merchant-level info keyed by shopDomain.
 *
 * Body:
 * {
 *   "shopDomain": "my-store.myshopify.com",
 *   "displayName": "My Store",
 *   "planTier": "free" | "starter" | "growth" | "enterprise",
 *   "status": "healthy" | "watch" | "broken" | "inactive",
 *   "installedAt": "2025-12-01T00:00:00.000Z",
 *   "lastSeenAt": "2025-12-06T11:00:00.000Z",
 *   "notes": "optional notes"
 * }
 */
app.post("/abando/merchant", async (req: Request, res: Response) => {
  try {
    const {
      shopDomain,
      displayName,
      planTier = "free",
      status = "healthy",
      installedAt,
      lastSeenAt,
      notes,
    } = req.body ?? {};

    if (!shopDomain || !displayName) {
      return res.status(400).json({
        ok: false,
        error: "shopDomain and displayName are required",
      });
    }

    // Dates – default to "now" if not provided
    const installed = installedAt ? new Date(installedAt) : new Date();
    const lastSeen = lastSeenAt ? new Date(lastSeenAt) : new Date();

    const merchantId = randomUUID();

    const result = await pool.query(
      `
      INSERT INTO "AbandoMerchant"
        ("id", "shopDomain", "displayName", "planTier", "installedAt", "lastSeenAt", "status", "notes", "createdAt", "updatedAt")
      VALUES
        ($1, $2, $3, $4::"AbandoPlanTier", $5, $6, $7::"MerchantStatus", $8, NOW(), NOW())
      ON CONFLICT ("shopDomain")
      DO UPDATE SET
        "displayName" = EXCLUDED."displayName",
        "planTier" = EXCLUDED."planTier",
        "lastSeenAt" = EXCLUDED."lastSeenAt",
        "status" = EXCLUDED."status",
        "notes" = COALESCE(EXCLUDED."notes", "AbandoMerchant"."notes"),
        "updatedAt" = NOW()
      RETURNING *;
      `,
      [
        merchantId,
        shopDomain,
        displayName,
        planTier,
        installed,
        lastSeen,
        status,
        notes ?? null,
      ],
    );

    return res.status(200).json({
      ok: true,
      merchant: result.rows[0],
    });
  } catch (err: any) {
    console.error("Error in /abando/merchant:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message ?? "Unknown error",
    });
  }
});

/**
 * POST /abando/daily-stat
 * Upsert one daily stat row for a merchant.
 *
 * Body:
 * {
 *   "shopDomain": "my-store.myshopify.com",
 *   "date": "2025-12-06",
 *   "cartsTotal": 10,
 *   "cartsAbandoned": 4,
 *   "cartsRecovered": 3,
 *   "revenueRecoveredCents": 12345,
 *   "exportOk": true,
 *   "errorsCount": 0,
 *   "statusFlag": "ok" | "warning" | "error"
 * }
 */
app.post("/abando/daily-stat", async (req: Request, res: Response) => {
  try {
    const {
      shopDomain,
      date,
      cartsTotal,
      cartsAbandoned,
      cartsRecovered,
      revenueRecoveredCents,
      exportOk = true,
      errorsCount = 0,
      statusFlag = "ok",
    } = req.body ?? {};

    if (!shopDomain || !date) {
      return res.status(400).json({
        ok: false,
        error: "shopDomain and date are required",
      });
    }

    // Normalize date to midnight for uniqueness (merchantId + date)
    const statDate = new Date(date);
    if (Number.isNaN(statDate.getTime())) {
      return res.status(400).json({
        ok: false,
        error: "Invalid date format",
      });
    }

    // 1) Look up merchantId by shopDomain
    const merchantRes = await pool.query(
      `SELECT "id" FROM "AbandoMerchant" WHERE "shopDomain" = $1`,
      [shopDomain],
    );

    if (merchantRes.rowCount === 0) {
      return res.status(404).json({
        ok: false,
        error: "Merchant not found for given shopDomain",
      });
    }

    const merchantId: string = merchantRes.rows[0].id;

    // 2) Upsert daily stat
    const dailyStatId = randomUUID();
    const cartsTotalNum = cartsTotal ?? 0;
    const cartsAbandonedNum = cartsAbandoned ?? 0;
    const cartsRecoveredNum = cartsRecovered ?? 0;
    const revenueRecoveredCentsNum = revenueRecoveredCents ?? 0;
    const recoveryRate =
      cartsTotalNum > 0 ? cartsRecoveredNum / cartsTotalNum : 0;

    const statRes = await pool.query(
      `
      INSERT INTO "AbandoMerchantDailyStat"
        ("id", "merchantId", "date", "cartsTotal", "cartsAbandoned", "cartsRecovered",
         "recoveryRate", "revenueRecoveredCents", "exportOk", "errorsCount", "statusFlag", "createdAt", "updatedAt")
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::"DailyStatusFlag", NOW(), NOW())
      ON CONFLICT ("merchantId", "date")
      DO UPDATE SET
        "cartsTotal" = EXCLUDED."cartsTotal",
        "cartsAbandoned" = EXCLUDED."cartsAbandoned",
        "cartsRecovered" = EXCLUDED."cartsRecovered",
        "recoveryRate" = EXCLUDED."recoveryRate",
        "revenueRecoveredCents" = EXCLUDED."revenueRecoveredCents",
        "exportOk" = EXCLUDED."exportOk",
        "errorsCount" = EXCLUDED."errorsCount",
        "statusFlag" = EXCLUDED."statusFlag",
        "updatedAt" = NOW()
      RETURNING *;
      `,
      [
        dailyStatId,
        merchantId,
        statDate.toISOString(),
        cartsTotalNum,
        cartsAbandonedNum,
        cartsRecoveredNum,
        recoveryRate,
        revenueRecoveredCentsNum,
        exportOk,
        errorsCount,
        statusFlag,
      ],
    );

    return res.status(200).json({
      ok: true,
      dailyStat: statRes.rows[0],
    });
  } catch (err: any) {
    console.error("Error in /abando/daily-stat:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message ?? "Unknown error",
    });
  }
});

const PORT = Number(process.env.PORT) || 4000;

app.listen(PORT, () => {
  console.log(`StaffordOS Command Center API listening on port ${PORT}`);
});
