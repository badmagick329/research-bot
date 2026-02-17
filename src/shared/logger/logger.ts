import pino from "pino";

export const logger = pino({
  name: "research-bot",
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
});
