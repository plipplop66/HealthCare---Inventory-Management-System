const crypto = require('node:crypto');
const cors = require('cors');
const express = require('express');
const { createApiRouter } = require('./routes');
const { AppError, asyncHandler } = require('./errors');
const { createAuthService } = require('./auth');
const { createAuthStore } = require('./auth-store');
const { createIntelligenceAdapter } = require('./intelligence-adapter');
const { createInventoryStore } = require('./inventory-store');

// dependencies lets tests supply stores (for example with a private, closable database pool).
function createApp(config, dependencies = {}) {
  const app = express();
  const authConfig = {
    ...config,
    authJwtSecret: config.authJwtSecret || (config.environment === 'production' ? '' : 'medripple-local-development-secret-change-before-deployment'),
    authTokenTtlMinutes: config.authTokenTtlMinutes || 8 * 60
  };
  const allowedOrigins = new Set(config.corsOrigins);
  const inventoryStore = dependencies.inventoryStore || createInventoryStore(config);
  const authStore = dependencies.authStore || createAuthStore(config);
  const authService = createAuthService(authConfig, authStore);

  app.disable('x-powered-by');
  // Inventory and account responses must not survive in browser/CDN caches.
  app.use((request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use((request, response, next) => {
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.use((request, response, next) => {
    response.locals.requestId = request.get('x-request-id') || crypto.randomUUID();
    response.setHeader('x-request-id', response.locals.requestId);
    next();
  });
  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.size === 0 || allowedOrigins.has(origin)) return callback(null, true);
      return callback(new AppError(403, 'CORS_ORIGIN_DENIED', 'This browser origin is not allowed.'));
    }
  }));
  app.use(express.json({ limit: '128kb' }));
  app.use((request, response, next) => {
    const started = Date.now();
    response.on('finish', () => {
      console.info(JSON.stringify({ requestId: response.locals.requestId, method: request.method, path: request.path, status: response.statusCode, durationMs: Date.now() - started }));
    });
    next();
  });

  // Visiting a Vercel backend URL directly is a common deployment check. Make
  // it useful instead of returning the generic application 404; API clients
  // should continue to use /api/* and operational checks should use /health.
  app.get('/', (request, response) => {
    response.json({
      data: {
        service: 'medripple-backend',
        status: 'ok',
        health: '/health',
        apiBase: '/api'
      },
      meta: { requestId: response.locals.requestId }
    });
  });

  app.get('/health', asyncHandler(async (request, response) => {
    const database = await inventoryStore.getHealth();
    response.json({
      data: { status: 'ok', service: 'medripple-backend', environment: config.environment, dataSource: inventoryStore.source, database },
      meta: { requestId: response.locals.requestId }
    });
  }));
  app.use('/api', createApiRouter({
    authService,
    config,
    intelligenceAdapter: createIntelligenceAdapter(config, inventoryStore),
    inventoryStore
  }));
  app.use((request, response, next) => next(new AppError(404, 'NOT_FOUND', 'The requested route does not exist.')));
  app.use((error, request, response, next) => {
    const knownError = error instanceof AppError;
    const status = knownError ? error.status : 500;
    if (!knownError) console.error(error);
    response.status(status).json({
      error: {
        code: knownError ? error.code : 'INTERNAL_ERROR',
        message: knownError ? error.message : 'An unexpected error occurred.',
        ...(knownError && error.details ? { details: error.details } : {})
      },
      meta: { requestId: response.locals.requestId }
    });
  });
  return app;
}

module.exports = { createApp };
