import pino from 'pino';
import path from 'node:path';
import { config } from './config.js';

const isDev = config.runtime.nodeEnv === 'development';
const logFile = path.join(config.runtime.logDir, 'agent.log');

const transport = isDev
  ? pino.transport({
      targets: [
        {
          target: 'pino-pretty',
          level: 'warn',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname,app',
            destination: 2,
          },
        },
        {
          target: 'pino-pretty',
          level: 'debug',
          options: {
            colorize: false,
            translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
            ignore: 'pid,hostname',
            destination: logFile,
            mkdir: true,
            append: true,
          },
        },
      ],
    })
  : pino.destination({ dest: logFile, sync: false, mkdir: true });

export const logger = pino(
  {
    level: config.runtime.logLevel,
    base: { app: 'ai-ops-agent' },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  transport,
);

export type Logger = typeof logger;
