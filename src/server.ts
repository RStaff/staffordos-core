import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

// Use the DATABASE_URL from .env
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Prisma 7: direct DB connection via driver adapter
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const app = express();
app.use(bodyParser.json());

// Simple health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "staffordos-core" });
});

const PORT = Number(process.env.PORT) || 4000;

app.listen(PORT, () => {
  console.log(`StaffordOS Command Center API listening on port ${PORT}`);
});
