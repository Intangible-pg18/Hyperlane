import pino, {Logger, LoggerOptions} from "pino"

//Redaction rule: The following keys would be redacted if found in any log object

const REDACT_KEYS = [
    "password",
    "token",
    "accessToken",
    "refreshToken",
    "authorization",
    "secret",
    "creditCard",
    "cvv"
];

export type { Logger };

export const createLogger = (serviceName: string): Logger => {
    const isDev = process.env.NODE_ENV === "development";


    const options: LoggerOptions = {
        name: serviceName,
        level: process.env.LOG_LEVEL || "info",
        redact: {
            paths: REDACT_KEYS,
            censor: "[REDACTED]"
        },
        ...(isDev && {
            transport: {
                target: "pino-pretty",
                options: {
                    colorize: true,
                    ignore: "pid, hostname",
                    translateTime: "SYS:standard"
                }
            }
        }),
        base: {
            service: serviceName,
            env: process.env.NODE_ENV
        }
    };
    return pino(options);
};