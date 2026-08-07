// ============================================================================
//  Tiny dependency-free leveled logger for the POS Sol Terminal.
//
//  Levels (most → least severe):  error < warn < info < debug
//  A message is printed only if its level is at or below the configured level,
//  e.g. logLevel "info" prints error+warn+info but not debug.
//
//  Configure once at startup with configure(level) (from config.yaml
//  posTerminal.logLevel). Output goes to the console with a timestamp, a
//  colored level tag and an optional structured-context object.
// ============================================================================

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const COLORS = {
  error: '\x1b[31m', // red
  warn: '\x1b[33m',  // yellow
  info: '\x1b[36m',  // cyan
  debug: '\x1b[90m', // gray
  reset: '\x1b[0m',
};

let threshold = LEVELS.info;
let useColor = process.stdout.isTTY;

function configure(level) {
  const key = String(level || 'info').toLowerCase();
  if (key in LEVELS) {
    threshold = LEVELS[key];
  } else {
    // Unknown level: fall back to info and warn about it.
    threshold = LEVELS.info;
    emit('warn', `unknown logLevel "${level}", defaulting to "info"`);
  }
  return key in LEVELS ? key : 'info';
}

function emit(level, msg, ctx) {
  if (LEVELS[level] > threshold) return;

  const ts = new Date().toISOString();
  const tag = level.toUpperCase().padEnd(5);
  const color = useColor ? COLORS[level] : '';
  const reset = useColor ? COLORS.reset : '';

  let line = `${ts} ${color}${tag}${reset} ${msg}`;
  if (ctx && Object.keys(ctx).length > 0) {
    line += ' ' + formatCtx(ctx);
  }
  const sink = level === 'error' ? console.error : console.log;
  sink(line);
}

// Render context as compact key=value pairs (objects/arrays are JSON-encoded).
function formatCtx(ctx) {
  return Object.entries(ctx)
    .map(([k, v]) => {
      const val = typeof v === 'object' && v !== null ? JSON.stringify(v) : v;
      return `${k}=${val}`;
    })
    .join(' ');
}

export const log = {
  error: (msg, ctx) => emit('error', msg, ctx),
  warn: (msg, ctx) => emit('warn', msg, ctx),
  info: (msg, ctx) => emit('info', msg, ctx),
  debug: (msg, ctx) => emit('debug', msg, ctx),
};

export { configure, LEVELS };
