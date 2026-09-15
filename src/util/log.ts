export type LogLevel = "debug" | "info" | "warn" | "error";

const level_order: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let current_level: LogLevel = "info";

export function set_log_level(level: LogLevel): void {
  current_level = level;
}

export function log(level: LogLevel, message: string, data?: unknown): void {
  if (level_order[level] < level_order[current_level]) {
    return;
  }
  const line = `[lich:${level}] ${message}`;
  if (data === undefined) {
    console.error(line);
    return;
  }
  console.error(line, data);
}

export const logger = {
  debug: (message: string, data?: unknown) => log("debug", message, data),
  info: (message: string, data?: unknown) => log("info", message, data),
  warn: (message: string, data?: unknown) => log("warn", message, data),
  error: (message: string, data?: unknown) => log("error", message, data),
};