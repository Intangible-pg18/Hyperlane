import "dotenv/config"; // Loading env vars before anything else
import express, { Request, Response, NextFunction } from "express";
import helmet from "helmet"
import cors from "cors"
import compression from "compression"
import cookieParser from "cookie-parser"
import hpp from "hpp";
import {createLogger} from "@hyperlane/logger"
import { randomUUID } from "node:crypto";
import { handleClerkWebhook } from "./controllers/webhook.controller.js";
import { startGrpcServer } from "./grpc/server.js";

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

const logger = createLogger("auth-service")

process.on("unhandledRejection", (reason, promise) => {
    logger.error({reason, promise}, "Unhandled Rejection! Shutting down...");
    process.exit(1); // K8s restarts us clean
})
process.on("uncaughtException", (error) => {
  logger.error({ error }, "Uncaught Exception! Shutting down...");
  process.exit(1);
});

const app = express();
const PORT = process.env.PORT || 3001;
const IS_PROD = process.env.NODE_ENV === "production";

//enables express to trust the load-balancer or RP in front and to look at the X-forwarded headers to get the user's IP/protocol/port
app.set("trust proxy", 1);
// Disable the "X-Powered-By: Express" header in the responses so as to prevent fingerprinting attacks
app.disable("x-powered-by");

//distributed tracing
app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = (req.headers["x-request-id"] as string) || randomUUID();
    req.headers["x-request-id"] = requestId;
    res.setHeader("x-request-id", requestId);
    next();
});

//security headers
app.use(helmet());

// Tells the server to include the CORS headers in every response
app.use(cors({
    origin: IS_PROD ? process.env.ALLOWED_ORIGINS?.split(",") : "*",
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-request-id", "svix-id", "svix-timestamp", "svix-signature"]
}));

app.use(compression());
//file size limit to prevent dos attack
app.use(express.json({limit: "10kb", 
  verify: (req: Request, res: Response, buf: Buffer) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true, limit: "10kb"}))
app.use(cookieParser());

//prevent of HTTP Parameter Pollution attacks
app.use(hpp());

// Observability Middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;
    const logLevel = res.statusCode >= 400 ? "warn" : "info";
    
    logger[logLevel]({
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration: `${duration}ms`,
      requestId: req.headers["x-request-id"],
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    }, "HTTP Request");
  });
  
  next();
});

//health check for K8s liveness probe
app.get("/health", (req, res) => {
    res.status(200).json({status: "ok", service: "auth-service", timestamp: new Date().toISOString()});
})

app.post("/api/webhooks/clerk", handleClerkWebhook)

//404 handler (for unknown routes)
app.use((req: Request, res: Response) => {
    res.status(404).json({
        error: "Not found",
        requestId: req.headers["x-request-id"]
    })
})

//error formatting
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  logger.error({ err, requestId: req.headers["x-request-id"] }, "Unhandled Request Error");
  
  res.status(err.status || 500).json({
    error: IS_PROD ? "Internal Server Error" : err.message,
    requestId: req.headers["x-request-id"],
  });
});

// Server Start (Dual Protocol)
const httpServer = app.listen(PORT, () => {
    logger.info(`Auth Service running on port ${PORT}`);
})

//Keep-Alive Timeout Sync
httpServer.keepAliveTimeout = 65000; 
httpServer.headersTimeout = 66000;   

// Starting gRPC Server
let stopGrpcServer: () => Promise<void>;

try {
  stopGrpcServer = startGrpcServer();
} catch (err) {
  logger.fatal({ err }, "Failed to start gRPC server");
  process.exit(1);
}

//graceful shutdown 
const shutdown = async (signal: string) => {
  logger.info(`Received ${signal}. Starting graceful shutdown...`);
  const shutdownPromises: Promise<void>[] = [];
  // Stopping REST
  shutdownPromises.push(new Promise((resolve) => {
    httpServer.close(() => {
      logger.info("REST server closed.");
      resolve();
    });
  }));
  // Stopping gRPC
  if (stopGrpcServer) {
    shutdownPromises.push(stopGrpcServer().then(() => {
      logger.info("gRPC server closed.");
    }));
  }

  try {
    await Promise.all(shutdownPromises);
    logger.info("All services stopped. Exiting.");
    process.exit(0);
  }
  catch(err) {
    logger.error({err}, "Shutdown failed");
    process.exit(1);
  }
};

// Force exiting if shutdown takes too long
const forceShutdown = setTimeout(() => {
  logger.error("Forcefully shutting down due to timeout");
  process.exit(1);
}, 10000);
forceShutdown.unref(); //so that node doesnt wait for the timer in case of normal shutdown

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));