import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { apiRouter } from "./routes/api";

function isRpcConfigured(): boolean {
  const helius = (process.env.HELIUS_RPC_URL || "").trim();
  const sol = (process.env.SOLANA_RPC_URL || "").trim();
  return !!(helius || sol);
}

export function createApp(userDataPath?: string): express.Application {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use("/api", apiRouter);
  app.use(express.static(path.join(__dirname, "public")));

  if (userDataPath) {
    app.get("/api/config/status", (_req, res) => {
      res.json({ configured: isRpcConfigured() });
    });

    app.post("/api/config/save", (req, res) => {
      try {
        const { heliusRpcUrl, bubblemapsApiKey } = req.body;

        if (!heliusRpcUrl || !heliusRpcUrl.startsWith("https://")) {
          return res.status(400).json({ error: "Valid Helius RPC URL required" });
        }

        const envPath = path.join(userDataPath, ".env");
        let lines: string[] = [];

        if (fs.existsSync(envPath)) {
          const existing = fs.readFileSync(envPath, "utf-8");
          lines = existing.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("HELIUS_RPC_URL=") && !l.startsWith("BUBBLEMAPS_API_KEY=") && !l.startsWith("SOLANA_RPC_URL=") && !l.startsWith("PORT="));
        }

        if (bubblemapsApiKey) {
          lines.push(`BUBBLEMAPS_API_KEY=${bubblemapsApiKey}`);
        }
        lines.push(`HELIUS_RPC_URL=${heliusRpcUrl}`);
        lines.push("PORT=3000");

        const content = lines.join("\n") + "\n";
        fs.writeFileSync(envPath, content, "utf-8");

        process.env.HELIUS_RPC_URL = heliusRpcUrl;
        if (bubblemapsApiKey) {
          process.env.BUBBLEMAPS_API_KEY = bubblemapsApiKey;
        }
        process.env.PORT = "3000";

        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message || "Failed to save config" });
      }
    });

    app.get("/setup", (_req, res) => {
      res.sendFile(path.join(__dirname, "public", "setup.html"));
    });
  }

  app.get("/", (_req, res) => {
    if (userDataPath && !isRpcConfigured()) {
      return res.sendFile(path.join(__dirname, "public", "setup.html"));
    }
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  return app;
}
