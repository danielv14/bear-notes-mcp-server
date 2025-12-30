type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

// Set minimum log level via environment variable, default to "info"
const MIN_LEVEL = (process.env.BEAR_MCP_LOG_LEVEL as LogLevel) || "info";

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
