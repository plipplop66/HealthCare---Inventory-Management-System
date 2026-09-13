const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function readInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function createConfig(environment = process.env) {
  const originList = (environment.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    environment: environment.NODE_ENV || 'development',
    host: environment.BACKEND_HOST || '127.0.0.1',
    port: readInteger(environment.BACKEND_PORT, 3001),
    dataSource: environment.DATA_SOURCE || 'fixture',
    databaseUrl: environment.DATABASE_URL || '',
    databaseHost: environment.DATABASE_HOST || '127.0.0.1',
    databasePort: readInteger(environment.DATABASE_PORT, 3306),
    databaseName: environment.DATABASE_NAME || 'medripple',
    databaseUser: environment.DATABASE_USER || 'medripple',
    databasePassword: environment.DATABASE_PASSWORD || '',
    simulationDate: environment.SIMULATION_DATE || '2026-09-11',
    corsOrigins: originList,
    intelligenceServiceUrl: (environment.INTELLIGENCE_SERVICE_URL || '').replace(/\/$/, ''),
    intelligenceTimeoutMs: readInteger(environment.INTELLIGENCE_TIMEOUT_MS, 2500)
  };
}

module.exports = { createConfig };
