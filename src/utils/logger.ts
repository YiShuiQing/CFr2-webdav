export const logger = {
  error: (message: string, ...args: unknown[]) => {
    console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, ...args);
  },
};
