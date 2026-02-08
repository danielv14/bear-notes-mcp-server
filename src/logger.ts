type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

const VALID_LOG_LEVELS: readonly string[] = ["debug", "info", "warn", "error"];

const getLogLevel = (): LogLevel => {
  const env = process.env.BEAR_MCP_LOG_LEVEL;
  if (env && VALID_LOG_LEVELS.includes(env)) return env as LogLevel;
  return "info";
};

const MIN_LEVEL = getLogLevel();

const shouldLog = (level: LogLevel): boolean => {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[MIN_LEVEL];
};

const formatMessage = (level: LogLevel, message: string, data?: unknown): string => {
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` ${JSON.stringify(data)}` : "";
  return `[${timestamp}] [${level.toUpperCase()}] ${message}${dataStr}`;
};

export const logger = {
  debug(message: string, data?: unknown) {
    if (shouldLog("debug")) {
      console.error(formatMessage("debug", message, data));
    }
  },

  info(message: string, data?: unknown) {
    if (shouldLog("info")) {
      console.error(formatMessage("info", message, data));
    }
  },

  warn(message: string, data?: unknown) {
    if (shouldLog("warn")) {
      console.error(formatMessage("warn", message, data));
    }
  },

  error(message: string, data?: unknown) {
    if (shouldLog("error")) {
      console.error(formatMessage("error", message, data));
    }
  }
};
