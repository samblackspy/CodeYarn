// src/core/serverSetup.ts
import express, { Express, Request, Response } from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import { PORT, CORS_ORIGIN } from "../config"; // Added CORS_ORIGIN import

export const app: Express = express();
export const httpServer = http.createServer(app);

export function setupBaseRoutes(app: Express) {
  app.get("/api/health", (req: Request, res: Response) => {
    res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
  });
}

export function startServer(io: SocketIOServer) {
  httpServer.listen(PORT, () => {
    console.log(`--------------------------------------`);
    console.log(`  CodeYarn Server listening on port ${PORT}`);
    console.log(`  Allowed CORS origin: ${CORS_ORIGIN}`);
    console.log(`--------------------------------------`);
  });

  process.on("SIGTERM", () => {
    console.log("SIGTERM signal received: closing HTTP server");
    io.close(() => {
      console.log("[Socket.IO] Server closed.");
      httpServer.close(() => {
        console.log("HTTP server closed.");
        process.exit(0);
      });
    });
  });
}
