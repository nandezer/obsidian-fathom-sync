const PREFIX = "[Fathom Sync]";

export const logger = {
  debug(msg: string, ...args: unknown[]): void {
    console.debug(PREFIX, msg, ...args);
  },
  info(msg: string, ...args: unknown[]): void {
    console.info(PREFIX, msg, ...args);
  },
  warn(msg: string, ...args: unknown[]): void {
    console.warn(PREFIX, msg, ...args);
  },
  error(msg: string, ...args: unknown[]): void {
    console.error(PREFIX, msg, ...args);
  },
};
