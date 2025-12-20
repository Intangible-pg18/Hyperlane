import Redis from "ioredis";
import {createLogger} from "@hyperlane/logger"

const logger = createLogger("auth-service")

const getRedisUrl = () => {
    if(process.env.REDIS_URL) return process.env.REDIS_URL;
  
    if (process.env.NODE_ENV === "production") {
        throw new Error("REDIS_URL is not defined in production environment");
    }
    
    return "redis://localhost:6379";
}

export const redis = new Redis(getRedisUrl(), {
    maxRetriesPerRequest: null, //infinite retries
    enableReadyCheck: true, //Redis client waits for redis server to be ready (load data from db/aof and all)
    retryStrategy(times) {
        // exponential base: 50 * 2^(times-1), capped
        const expo = Math.min(50 * Math.pow(2, Math.max(0, times - 1)), 2000);
        // equal jitter: expo/2 + random([0, expo/2))
        const half = expo / 2;
        return Math.floor(half + Math.random() * half);
    }
});

// Observability Hooks

redis.on("connect", () => {
  logger.info("Redis client connected");
});

redis.on("ready", () => {
  logger.info("Redis client ready to accept commands");
});

// Prevent process crash on Redis error
redis.on("error", (err) => {
  logger.error({ err }, "Redis Client Error");
});

redis.on("close", () => {
  logger.warn("Redis connection closed");
});

redis.on("reconnecting", () => {
  logger.info("Redis reconnecting...");
});