import express from "express";
import cors from "cors";
import path from "path";
import dotenv from "dotenv";
import chalk from "chalk";
import { createApp } from "./app";

dotenv.config();

export function startServer(port: number) {
  const app = createApp();

  app.listen(port, () => {
    console.log("");
    console.log(chalk.cyan("  ═════════════════════════════════════════"));
    console.log(chalk.cyan("   Memecoin Checker Dashboard"));
    console.log(chalk.cyan("  ═════════════════════════════════════════"));
    console.log("");
    console.log(`  ${chalk.gray("Local:")} ${chalk.green(`http://localhost:${port}`)}`);
    console.log("");
    console.log(chalk.gray("  Press Ctrl+C to stop"));
    console.log("");
  });
}

if (require.main === module) {
  const port = parseInt(process.env.PORT || "3000", 10);
  startServer(port);
}
