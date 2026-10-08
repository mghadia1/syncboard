/** One JSON object per line on stdout, so the logs can be searched (by LogScope, say). */
export type Log = (event: string, fields?: Record<string, unknown>) => void;

export const jsonLog: Log = (event, fields = {}) => {
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), service: "syncboard", event, ...fields })}\n`,
  );
};

export const silentLog: Log = () => undefined;
