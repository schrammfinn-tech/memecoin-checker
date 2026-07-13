import { app, BrowserWindow, shell, dialog } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as dotenv from "dotenv";

function loadEnv() {
  const userDataPath = app.getPath("userData");
  const userEnvPath = path.join(userDataPath, ".env");

  if (fs.existsSync(userEnvPath)) {
    dotenv.config({ path: userEnvPath });
    console.log("Loaded .env from:", userEnvPath);
    return;
  }

  const possiblePaths = [
    path.join(app.getAppPath(), ".env"),
    path.join(process.cwd(), ".env"),
    path.join(path.dirname(process.execPath), ".env"),
  ];

  if (process.resourcesPath) {
    possiblePaths.push(path.join(process.resourcesPath, ".env"));
  }

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      dotenv.config({ path: p });
      console.log("Loaded .env from:", p);
      return;
    }
  }

  dotenv.config();
}

let mainWindow: BrowserWindow | null = null;
let httpServer: any = null;

async function startServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    try {
      const { createApp } = require("../app");
      const userDataPath = app.getPath("userData");
      const expressApp = createApp(userDataPath);
      httpServer = expressApp.listen(0, "127.0.0.1", () => {
        const addr = httpServer.address();
        console.log("Server started on port", addr.port);
        resolve(addr.port);
      });
      httpServer.on("error", (err: Error) => {
        reject(err);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function createWindow(port: number) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "DECIPHER",
    backgroundColor: "#0a0a0f",
    show: false,
    fullscreenable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
    },
    icon: path.join(__dirname, "..", "public", "icon.png"),
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.maximize();

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`).catch((err) => {
    console.error("Failed to load URL:", err.message);
    dialog.showErrorBox("Connection Error", `Failed to connect to app: ${err.message}`);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-software-rasterizer");

app.whenReady().then(async () => {
  loadEnv();

  console.log("HELIUS_RPC_URL after loadEnv:", process.env.HELIUS_RPC_URL || "(not set)");
  console.log("SOLANA_RPC_URL after loadEnv:", process.env.SOLANA_RPC_URL || "(not set)");
  const configured = !!(process.env.HELIUS_RPC_URL || "").trim() || !!(process.env.SOLANA_RPC_URL || "").trim();
  console.log("RPC configured:", configured);

  try {
    const port = await startServer();
    createWindow(port);
  } catch (err: any) {
    console.error("Startup failed:", err);
    dialog.showErrorBox(
      "Failed to Start",
      `Error: ${err.message || err}\n\nCheck that .env is configured correctly.`
    );
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (httpServer) {
    httpServer.close();
  }
  app.quit();
});

app.on("activate", async () => {
  if (mainWindow === null) {
    try {
      const port = await startServer();
      createWindow(port);
    } catch (err: any) {
      console.error("Restart failed:", err);
      app.quit();
    }
  }
});
