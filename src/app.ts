import express from "express";
import cors from "cors";
import path from "path";
import { apiRouter } from "./routes/api";

export function createApp(): express.Application {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use("/api", apiRouter);
  app.use(express.static(path.join(__dirname, "public")));

  app.get("/", (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  return app;
}
