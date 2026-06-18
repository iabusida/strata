/**
 * Simple logger utility for consistent formatting
 */

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function formatTimestamp(): string {
  const now = new Date();
  return now.toISOString().slice(11, 23); // HH:MM:SS.sss
}

function log(level: LogLevel, prefix: string, message: string, ...args: unknown[]): void {
  const timestamp = formatTimestamp();
  
  let levelColor = '';
  let levelLabel = '';
  
  switch (level) {
    case 'info':
      levelColor = colors.cyan;
      levelLabel = 'INFO';
      break;
    case 'warn':
      levelColor = colors.yellow;
      levelLabel = 'WARN';
      break;
    case 'error':
      levelColor = colors.red;
      levelLabel = 'ERROR';
      break;
    case 'debug':
      levelColor = colors.blue;
      levelLabel = 'DEBUG';
      break;
  }
  
  const formatted = `${colors.dim}${timestamp}${colors.reset} ${levelColor}${levelLabel}${colors.reset} ${prefix} ${message}`;
  
  if (level === 'error') {
    console.error(formatted, ...args);
  } else if (level === 'warn') {
    console.warn(formatted, ...args);
  } else {
    console.log(formatted, ...args);
  }
}

export const logger = {
  info: (message: string, ...args: unknown[]) => log('info', '[API]', message, ...args),
  warn: (message: string, ...args: unknown[]) => log('warn', '[API]', message, ...args),
  error: (message: string, ...args: unknown[]) => log('error', '[API]', message, ...args),
  debug: (message: string, ...args: unknown[]) => log('debug', '[API]', message, ...args)
};
