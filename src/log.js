/**
 * Tiny structured JSON logger.
 *
 * Emits one JSON object per line to stdout (info/debug) or stderr (warn/error)
 * so NSSM on Windows and journald on Linux can each capture them into a
 * rotating log without further configuration.
 *
 * Calling convention follows pino-ish ergonomics:
 *
 *   log.info("listening");
 *   log.info({ port: 8080 }, "listening");
 *
 * No external dependency; the indexer and routes need a logger that works
 * before npm install has been verified.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] ?? 20;

function emit(level, fields, msg) {
  if (LEVELS[level] < minLevel) return;
  const rec = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields || {}),
  };
  const line = JSON.stringify(rec);
  if (level === "warn" || level === "error") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

function mk(level) {
  return (...args) => {
    let fields = null;
    let msg = "";
    if (args.length === 1) {
      if (typeof args[0] === "string") msg = args[0];
      else { fields = args[0]; msg = ""; }
    } else if (args.length >= 2) {
      fields = args[0];
      msg = String(args[1]);
    }
    emit(level, fields, msg);
  };
}

export const log = {
  debug: mk("debug"),
  info: mk("info"),
  warn: mk("warn"),
  error: mk("error"),
};
