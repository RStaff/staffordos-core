import "dotenv/config";
import express, { type Request, type Response } from "express";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import bodyParser from "body-parser";
import { Pool } from "pg";
import { randomUUID } from "crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set in environment (.env)");
}

const databaseUrl = process.env.DATABASE_URL;

const shouldUseSsl =
  !!databaseUrl &&
  (databaseUrl.includes("sslmode=require") ||
    (databaseUrl.includes(".com") && !databaseUrl.includes("localhost")));

const pool = new Pool(
  shouldUseSsl
    ? {
        connectionString: databaseUrl,
        ssl: { rejectUnauthorized: false },
      }
    : {
        connectionString: databaseUrl,
      }
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "../public");

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});
app.use(bodyParser.json());
app.use(express.static(publicDir));

app.get("/", (_req: Request, res: Response) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.get("/command-center", (_req: Request, res: Response) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.get("/home", (_req: Request, res: Response) => {
  res.sendFile(path.join(publicDir, "home.html"));
});

app.get("/rossllm", (_req: Request, res: Response) => {
  res.sendFile(path.join(publicDir, "rossllm.html"));
});

app.get("/abando-dashboard", (_req: Request, res: Response) => {
  res.sendFile(path.join(publicDir, "abando-dashboard.html"));
});

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


/**
 * GET /abando/merchant/:shopDomain
 * Fetch one merchant by shopDomain.
 */
app.get("/abando/merchant/:shopDomain", async (req: Request, res: Response) => {
  try {
    const shopDomain = String(req.params.shopDomain || "").trim();

    if (!shopDomain) {
      return res.status(400).json({
        ok: false,
        error: "shopDomain is required",
      });
    }

    const result = await pool.query(
      `
      SELECT *
      FROM "AbandoMerchant"
      WHERE "shopDomain" = $1
      LIMIT 1
      `,
      [shopDomain],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        ok: false,
        error: "Merchant not found",
      });
    }

    return res.status(200).json({
      ok: true,
      merchant: result.rows[0],
    });
  } catch (err: any) {
    console.error("Error in GET /abando/merchant/:shopDomain:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message ?? "Unknown error",
    });
  }
});

/**
 * GET /abando/merchant/:shopDomain/stats
 * Fetch daily stats for one merchant, newest first.
 * Optional query param: ?limit=30
 */
app.get("/abando/merchant/:shopDomain/stats", async (req: Request, res: Response) => {
  try {
    const shopDomain = String(req.params.shopDomain || "").trim();
    const limitRaw = Number(req.query.limit ?? 30);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(100, limitRaw))
      : 30;

    if (!shopDomain) {
      return res.status(400).json({
        ok: false,
        error: "shopDomain is required",
      });
    }

    const merchantRes = await pool.query(
      `
      SELECT *
      FROM "AbandoMerchant"
      WHERE "shopDomain" = $1
      LIMIT 1
      `,
      [shopDomain],
    );

    if (merchantRes.rowCount === 0) {
      return res.status(404).json({
        ok: false,
        error: "Merchant not found",
      });
    }

    const merchant = merchantRes.rows[0];

    const statsRes = await pool.query(
      `
      SELECT *
      FROM "AbandoMerchantDailyStat"
      WHERE "merchantId" = $1
      ORDER BY "date" DESC
      LIMIT $2
      `,
      [merchant.id, limit],
    );

    return res.status(200).json({
      ok: true,
      merchant,
      stats: statsRes.rows,
    });
  } catch (err: any) {
    console.error("Error in GET /abando/merchant/:shopDomain/stats:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message ?? "Unknown error",
    });
  }
});

/**
 * GET /abando/merchants
 * List merchants, newest installs first.
 * Optional query param: ?limit=50
 */
app.get("/abando/merchants", async (req: Request, res: Response) => {
  try {
    const limitRaw = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(200, limitRaw))
      : 50;

    const result = await pool.query(
      `
      SELECT *
      FROM "AbandoMerchant"
      ORDER BY "installedAt" DESC, "createdAt" DESC
      LIMIT $1
      `,
      [limit],
    );

    return res.status(200).json({
      ok: true,
      merchants: result.rows,
      count: result.rows.length,
    });
  } catch (err: any) {
    console.error("Error in GET /abando/merchants:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message ?? "Unknown error",
    });
  }
});


/**
 * GET /homebase/notes
 * Optional query params:
 *   ?category=family
 *   ?limit=20
 */
app.get("/homebase/notes", async (req: Request, res: Response) => {
  try {
    const category = String(req.query.category || "").trim();
    const rawLimit = Number(req.query.limit || 20);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 100)) : 20;

    let sql = `
      SELECT "id", "title", "body", "category", "createdAt", "updatedAt"
      FROM "HomeBaseNote"
    `;
    const params: any[] = [];

    if (category) {
      sql += ` WHERE "category" = $1`;
      params.push(category);
      sql += ` ORDER BY "createdAt" DESC LIMIT $2`;
      params.push(limit);
    } else {
      sql += ` ORDER BY "createdAt" DESC LIMIT $1`;
      params.push(limit);
    }

    const result = await pool.query(sql, params);

    return res.status(200).json({
      ok: true,
      notes: result.rows,
      count: result.rows.length,
    });
  } catch (err: any) {
    console.error("Error in GET /homebase/notes:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message ?? "Unknown error",
    });
  }
});

/**
 * POST /homebase/notes
 * Body:
 * {
 *   "title": "Grace school note",
 *   "body": "Reminder about Pingry paperwork.",
 *   "category": "family"
 * }
 */
app.post("/homebase/notes", async (req: Request, res: Response) => {
  try {
    const {
      title,
      body,
      category = "general",
    } = req.body ?? {};

    const titleText = String(title || "").trim();
    const bodyText = String(body || "").trim();
    const categoryText = String(category || "general").trim().toLowerCase();

    if (!titleText || !bodyText) {
      return res.status(400).json({
        ok: false,
        error: "title and body are required",
      });
    }

    const noteId = randomUUID();

    const result = await pool.query(
      `
      INSERT INTO "HomeBaseNote"
        ("id", "title", "body", "category", "createdAt", "updatedAt")
      VALUES
        ($1, $2, $3, $4, NOW(), NOW())
      RETURNING *;
      `,
      [noteId, titleText, bodyText, categoryText],
    );

    return res.status(200).json({
      ok: true,
      note: result.rows[0],
    });
  } catch (err: any) {
    console.error("Error in POST /homebase/notes:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message ?? "Unknown error",
    });
  }
});


/**
 * GET /homebase/events
 * Returns recent/upcoming Home Base events.
 */
app.get("/homebase/events", async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `
      SELECT *
      FROM "HomeBaseEvent"
      ORDER BY "startsAt" ASC, "createdAt" DESC
      LIMIT 50;
      `
    );

    return res.status(200).json({
      ok: true,
      events: result.rows,
      count: result.rows.length,
    });
  } catch (err: any) {
    console.error("Error in GET /homebase/events:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message ?? "Unknown error",
    });
  }
});

/**
 * POST /homebase/events
 * Creates one Home Base event.
 */
app.post("/homebase/events", async (req: Request, res: Response) => {
  try {
    const {
      title,
      startsAt,
      endsAt,
      category = "general",
      location,
      notes,
    } = req.body ?? {};

    const cleanTitle = String(title ?? "").trim();
    const cleanCategory = String(category ?? "general").trim() || "general";
    const cleanLocation = location == null ? null : String(location).trim()
    const cleanNotes = notes == null ? null : String(notes).trim()

    if (!cleanTitle || !startsAt) {
      return res.status(400).json({
        ok: false,
        error: "title and startsAt are required",
      });
    }

    const startDate = new Date(startsAt);
    if (Number.isNaN(startDate.getTime())) {
      return res.status(400).json({
        ok: false,
        error: "Invalid startsAt value",
      });
    }

    let endDate = null;
    if (endsAt) {
      const parsedEnd = new Date(endsAt);
      if (Number.isNaN(parsedEnd.getTime())) {
        return res.status(400).json({
          ok: false,
          error: "Invalid endsAt value",
        });
      }
      endDate = parsedEnd;
    }

    const eventId = randomUUID();

    const result = await pool.query(
      `
      INSERT INTO "HomeBaseEvent"
        ("id", "title", "startsAt", "endsAt", "category", "location", "notes", "createdAt", "updatedAt")
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
      RETURNING *;
      `,
      [
        eventId,
        cleanTitle,
        startDate.toISOString(),
        endDate ? endDate.toISOString() : null,
        cleanCategory,
        cleanLocation || null,
        cleanNotes || null,
      ],
    );

    return res.status(200).json({
      ok: true,
      event: result.rows[0],
    });
  } catch (err: any) {
    console.error("Error in POST /homebase/events:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message ?? "Unknown error",
    });
  }
});



/**
 * GET /abando/analytics/overview
 * Returns high-level founder analytics for Command Center.
 */



app.get("/abando/analytics/revenue-periods", async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT
        COALESCE(SUM(CASE
          WHEN "createdAt" >= date_trunc('day', now())
          THEN "recoveredRevenueCents" ELSE 0 END), 0)::bigint AS revenue_today_cents,
        COALESCE(SUM(CASE
          WHEN "createdAt" >= date_trunc('week', now())
          THEN "recoveredRevenueCents" ELSE 0 END), 0)::bigint AS revenue_week_cents,
        COALESCE(SUM(CASE
          WHEN "createdAt" >= date_trunc('month', now())
          THEN "recoveredRevenueCents" ELSE 0 END), 0)::bigint AS revenue_month_cents
      FROM "AbandoRecoveryEvent"
      WHERE LOWER(COALESCE("status", '')) = 'recovered'
    `);

    return res.status(200).json({
      ok: true,
      periods: result.rows[0] ?? {
        revenue_today_cents: 0,
        revenue_week_cents: 0,
        revenue_month_cents: 0,
      },
    });
  } catch (err: any) {
    console.error("Error in GET /abando/analytics/revenue-periods:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message ?? "Unknown error",
    });
  }
});

app.get("/abando/analytics/founder-metrics", async (_req: Request, res: Response) => {
  try {
    const merchantRes = await pool.query(`
      SELECT COUNT(*)::int AS total_merchants
      FROM "AbandoMerchant"
    `);

    const recoveryRes = await pool.query(`
      SELECT
        COALESCE(SUM("recoveredRevenueCents"), 0)::bigint AS total_revenue_cents,
        COUNT(*)::int AS total_carts_recovered
      FROM "AbandoRecoveryEvent"
      WHERE LOWER(COALESCE("status", '')) = 'recovered'
    `);

    const abandonedRes = await pool.query(`
      SELECT
        COUNT(*)::bigint AS total_carts_abandoned
      FROM "AbandoRecoveryEvent"
    `);

    return res.status(200).json({
      ok: true,
      metrics: {
        total_merchants: merchantRes.rows[0]?.total_merchants ?? 0,
        total_revenue_cents: recoveryRes.rows[0]?.total_revenue_cents ?? 0,
        total_carts_recovered: recoveryRes.rows[0]?.total_carts_recovered ?? 0,
        total_carts_abandoned: abandonedRes.rows[0]?.total_carts_abandoned ?? 0,
      },
    });
  } catch (err: any) {
    console.error("Error in GET /abando/analytics/founder-metrics:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message ?? "Unknown error",
    });
  }
});

app.get("/abando/analytics/channel-summary", async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `
      SELECT
        COALESCE("channel", 'email') AS channel,
        COUNT(*)::int AS recovery_count,
        COALESCE(SUM("recoveredRevenueCents"), 0)::bigint AS recovered_revenue_cents
      FROM "AbandoRecoveryEvent"
      WHERE LOWER(COALESCE("status", '')) = 'recovered'
      GROUP BY COALESCE("channel", 'email')
      ORDER BY recovered_revenue_cents DESC, channel ASC
      `
    );

    return res.status(200).json({
      ok: true,
      channels: result.rows,
    });
  } catch (err: any) {
    console.error("Error in GET /abando/analytics/channel-summary:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message ?? "Unknown error",
    });
  }
});

app.get("/abando/analytics/overview", async (_req: Request, res: Response) => {
  try {
    const merchantsRes = await pool.query(
      `
      SELECT
        COUNT(*)::int AS total_merchants,
        COUNT(*) FILTER (WHERE "status" = 'healthy')::int AS healthy_merchants,
        COUNT(*) FILTER (WHERE "status" = 'watch')::int AS watch_merchants,
        COUNT(*) FILTER (WHERE "status" = 'broken')::int AS broken_merchants,
        COUNT(*) FILTER (WHERE "status" = 'inactive')::int AS inactive_merchants
      FROM "AbandoMerchant";
      `
    );

    const statsRes = await pool.query(
      `
      SELECT
        COALESCE(SUM("revenueRecoveredCents"), 0)::bigint AS total_revenue_cents,
        COALESCE(SUM("cartsRecovered"), 0)::int AS total_carts_recovered,
        COALESCE(SUM("cartsAbandoned"), 0)::int AS total_carts_abandoned,
        COALESCE(MAX("date"), NULL) AS latest_stat_date
      FROM "AbandoMerchantDailyStat";
      `
    );

    const recentStatsRes = await pool.query(
      `
      SELECT
        s.*,
        m."shopDomain",
        m."displayName"
      FROM "AbandoMerchantDailyStat" s
      JOIN "AbandoMerchant" m
        ON m."id" = s."merchantId"
      ORDER BY s."date" DESC, s."updatedAt" DESC
      LIMIT 8;
      `
    );

    const merchantMixRes = await pool.query(
      `
      SELECT
        "status",
        COUNT(*)::int AS count
      FROM "AbandoMerchant"
      GROUP BY "status"
      ORDER BY count DESC, "status" ASC;
      `
    );

    return res.status(200).json({
      ok: true,
      overview: {
        ...(merchantsRes.rows[0] || {}),
        ...(statsRes.rows[0] || {}),
      },
      merchantMix: merchantMixRes.rows,
      recentStats: recentStatsRes.rows,
    });
  } catch (err: any) {
    console.error("Error in GET /abando/analytics/overview:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message ?? "Unknown error",
    });
  }
});



/**
 * GET /abando/recovery-events
 * Optional query params:
 *   ?shopDomain=demo-store.myshopify.com
 *   ?limit=20
 */
app.get("/abando/recovery-events", async (req: Request, res: Response) => {
  try {
    const shopDomain = String(req.query.shopDomain || "").trim();
    const limitRaw = Number(req.query.limit || 20);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;

    let result;

    if (shopDomain) {
      result = await pool.query(
        `
        SELECT *
        FROM "AbandoRecoveryEvent"
        WHERE "shopDomain" = $1
        ORDER BY "detectedAt" DESC, "createdAt" DESC
        LIMIT $2
        `,
        [shopDomain, limit]
      );
    } else {
      result = await pool.query(
        `
        SELECT *
        FROM "AbandoRecoveryEvent"
        ORDER BY "detectedAt" DESC, "createdAt" DESC
        LIMIT $1
        `,
        [limit]
      );
    }

    return res.status(200).json({
      ok: true,
      recoveryEvents: result.rows,
      count: result.rows.length,
    });
  } catch (err: any) {
    console.error("Error in GET /abando/recovery-events:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message ?? "Unknown error",
    });
  }
});

/**
 * POST /abando/recovery-events
 */
app.post("/abando/recovery-events", async (req: Request, res: Response) => {
  try {
    const {
      shopDomain,
      cartId,
      checkoutId,
      customerId,
      orderId,
      cartValueCents = 0,
      status = "detected",
      detectedAt,
      messageSentAt,
      recoveredAt,
      recoveredRevenueCents = 0,
      playbook,
      channel = "email",
    } = req.body ?? {};

    const cleanShopDomain = String(shopDomain || "").trim();
    const cleanStatus = String(status || "detected").trim();
    const cleanChannel = String(channel || "email").trim().toLowerCase();

    if (!cleanShopDomain) {
      return res.status(400).json({
        ok: false,
        error: "shopDomain is required",
      });
    }

    const merchantRes = await pool.query(
      `SELECT "id" FROM "AbandoMerchant" WHERE "shopDomain" = $1 LIMIT 1`,
      [cleanShopDomain]
    );

    if (merchantRes.rowCount === 0) {
      return res.status(404).json({
        ok: false,
        error: "Merchant not found for given shopDomain",
      });
    }

    const merchantId: string = merchantRes.rows[0].id;

    let existingRes;
    const cleanOrderId = orderId ? String(orderId).trim() : "";
    const cleanCheckoutId = checkoutId ? String(checkoutId).trim() : "";

    if (cleanOrderId) {
      existingRes = await pool.query(
        `
        SELECT *
        FROM "AbandoRecoveryEvent"
        WHERE "shopDomain" = $1
          AND "orderId" = $2
        LIMIT 1
        `,
        [cleanShopDomain, cleanOrderId]
      );
    } else if (cleanCheckoutId) {
      existingRes = await pool.query(
        `
        SELECT *
        FROM "AbandoRecoveryEvent"
        WHERE "shopDomain" = $1
          AND "checkoutId" = $2
        LIMIT 1
        `,
        [cleanShopDomain, cleanCheckoutId]
      );
    }

    if (existingRes && existingRes.rowCount && existingRes.rowCount > 0) {
      return res.status(200).json({
        ok: true,
        deduped: true,
        recoveryEvent: existingRes.rows[0],
      });
    }

    const recoveryEventId = randomUUID();

    const detectedDate = detectedAt ? new Date(detectedAt) : new Date();
    const messageSentDate = messageSentAt ? new Date(messageSentAt) : null;
    const recoveredDate = recoveredAt ? new Date(recoveredAt) : null;

    const result = await pool.query(
      `
      INSERT INTO "AbandoRecoveryEvent"
        ("id", "merchantId", "shopDomain", "cartId", "checkoutId", "customerId", "orderId",
         "cartValueCents", "status", "detectedAt", "messageSentAt", "recoveredAt",
         "recoveredRevenueCents", "playbook", "channel", "createdAt", "updatedAt")
      VALUES
        ($1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12,
         $13, $14, $15, NOW(), NOW())
      RETURNING *;
      `,
      [
        recoveryEventId,
        merchantId,
        cleanShopDomain,
        cartId ?? null,
        checkoutId ?? null,
        customerId ?? null,
        orderId ?? null,
        Number(cartValueCents || 0),
        cleanStatus,
        detectedDate.toISOString(),
        messageSentDate ? messageSentDate.toISOString() : null,
        recoveredDate ? recoveredDate.toISOString() : null,
        Number(recoveredRevenueCents || 0),
        playbook ?? null,
        cleanChannel,
      ]
    );

    const io = req.app.get("io");

    if (io) {
      const event = result.rows[0];

      io.to(`shop:${event.shopDomain}`).emit("recovery_event_created", {
        type: "recovery_event_created",
        shopDomain: event.shopDomain,
        recoveryEvent: event,
      });

      io.to("founder:global").emit("recovery_event_created", {
        type: "recovery_event_created",
        shopDomain: event.shopDomain,
        recoveryEvent: event,
      });
    }

    return res.status(200).json({
      ok: true,
      recoveryEvent: result.rows[0],
    });
  } catch (err: any) {
    console.error("Error in POST /abando/recovery-events:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message ?? "Unknown error",
    });
  }
});



/**
 * GET /abando/merchant-health
 */
app.get("/abando/merchant-health", async (req: Request, res: Response) => {
  try {
    const shopDomain = String(req.query.shopDomain || "").trim();

    let result;

    if (shopDomain) {
      result = await pool.query(
        `SELECT * FROM "AbandoMerchantHealth" WHERE "shopDomain" = $1 LIMIT 1`,
        [shopDomain]
      );

      return res.json({
        ok: true,
        health: result.rows[0] ?? null
      });
    }

    result = await pool.query(
      `SELECT * FROM "AbandoMerchantHealth" ORDER BY "updatedAt" DESC`
    );

    return res.json({
      ok: true,
      merchantHealth: result.rows
    });

  } catch (err: any) {
    console.error("Error in GET /abando/merchant-health:", err);
    res.status(500).json({
      ok: false,
      error: err?.message ?? "Unknown error"
    });
  }
});


/**
 * POST /abando/merchant-health
 */
app.post("/abando/merchant-health", async (req: Request, res: Response) => {
  try {
    const {
      shopDomain,
      status = "healthy",
      lastWebhookAt,
      lastRecoveryAt,
      lastNotificationAt,
      openIssueCount = 0,
      notes,
    } = req.body ?? {};

    const cleanShopDomain = String(shopDomain || "").trim();
    const cleanStatus = String(status || "healthy").trim();

    if (!cleanShopDomain) {
      return res.status(400).json({
        ok: false,
        error: "shopDomain is required"
      });
    }

    const merchantRes = await pool.query(
      `SELECT "id" FROM "AbandoMerchant" WHERE "shopDomain" = $1 LIMIT 1`,
      [cleanShopDomain]
    );

    if (merchantRes.rowCount === 0) {
      return res.status(404).json({
        ok: false,
        error: "Merchant not found for given shopDomain"
      });
    }

    const merchantId = merchantRes.rows[0].id;
    const healthId = randomUUID();

    const webhookDate = lastWebhookAt ? new Date(lastWebhookAt) : null;
    const recoveryDate = lastRecoveryAt ? new Date(lastRecoveryAt) : null;
    const notificationDate = lastNotificationAt ? new Date(lastNotificationAt) : null;

    const result = await pool.query(
      `
      INSERT INTO "AbandoMerchantHealth"
        ("id", "merchantId", "shopDomain", "status", "lastWebhookAt", "lastRecoveryAt",
         "lastNotificationAt", "openIssueCount", "notes", "createdAt", "updatedAt")
      VALUES
        ($1, $2, $3, $4, $5, $6,
         $7, $8, $9, NOW(), NOW())
      ON CONFLICT ("shopDomain")
      DO UPDATE SET
        "merchantId" = EXCLUDED."merchantId",
        "status" = EXCLUDED."status",
        "lastWebhookAt" = EXCLUDED."lastWebhookAt",
        "lastRecoveryAt" = EXCLUDED."lastRecoveryAt",
        "lastNotificationAt" = EXCLUDED."lastNotificationAt",
        "openIssueCount" = EXCLUDED."openIssueCount",
        "notes" = EXCLUDED."notes",
        "updatedAt" = NOW()
      RETURNING *;
      `,
      [
        healthId,
        merchantId,
        cleanShopDomain,
        cleanStatus,
        webhookDate ? webhookDate.toISOString() : null,
        recoveryDate ? recoveryDate.toISOString() : null,
        notificationDate ? notificationDate.toISOString() : null,
        Number(openIssueCount || 0),
        notes ?? null,
      ]
    );

    return res.json({
      ok: true,
      health: result.rows[0]
    });

  } catch (err: any) {
    console.error("Error in POST /abando/merchant-health:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message ?? "Unknown error"
    });
  }
});


io.on("connection", (socket) => {
  socket.on("subscribe:shop", (shopDomain: string) => {
    const cleanShop = String(shopDomain || "").trim();
    if (!cleanShop) return;
    socket.join(`shop:${cleanShop}`);
  });

  socket.on("unsubscribe:shop", (shopDomain: string) => {
    const cleanShop = String(shopDomain || "").trim();
    if (!cleanShop) return;
    socket.leave(`shop:${cleanShop}`);
  });

  socket.on("subscribe:founder", () => {
    socket.join("founder:global");
  });

  socket.on("unsubscribe:founder", () => {
    socket.leave("founder:global");
  });
});

app.set("io", io);


const PORT = Number(process.env.PORT) || 4000;

httpServer.listen(PORT, () => {
  console.log(`StaffordOS Command Center API listening on port ${PORT}`);
});
