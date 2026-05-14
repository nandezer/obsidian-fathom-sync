const PREFIX = "[Fathom Sync]";

type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let currentLevel: number = LEVELS.info;

export const logger = {
  setLevel(level: Level): void {
    currentLevel = LEVELS[level] ?? LEVELS.info;
  },
  debug(msg: string, ...args: unknown[]): void {
    if (currentLevel <= LEVELS.debug) console.debug(PREFIX, msg, ...args);
  },
  info(msg: string, ...args: unknown[]): void {
    if (currentLevel <= LEVELS.info) console.info(PREFIX, msg, ...args);
  },
  warn(msg: string, ...args: unknown[]): void {
    if (currentLevel <= LEVELS.warn) console.warn(PREFIX, msg, ...args);
  },
  error(msg: string, ...args: unknown[]): void {
    if (currentLevel <= LEVELS.error) console.error(PREFIX, msg, ...args);
  },
};
