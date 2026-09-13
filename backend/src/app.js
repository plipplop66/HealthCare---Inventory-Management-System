const crypto = require('node:crypto');
const cors = require('cors');
const express = require('express');
const { createApiRouter } = require('./routes');
const { AppError, asyncHandler } = require('./errors');
const { createIntelligenceAdapter } = require('./intelligence-adapter');
const { createInventoryStore } = require('./inventory-store');

function createApp(config) {
  const app = express();
  const allowedOrigins = new Set(config.corsOrigins);
  const inventoryStore = createInventoryStore(config);

  app.disable('x-powered-by');
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

  app.get('/health', asyncHandler(async (request, response) => {
    const database = await inventoryStore.getHealth();
    response.json({
      data: { status: 'ok', service: 'medripple-backend', environment: config.environment, dataSource: inventoryStore.source, database },
      meta: { requestId: response.locals.requestId }
    });
  }));
  app.use('/api', createApiRouter({ intelligenceAdapter: createIntelligenceAdapter(config, inventoryStore), inventoryStore }));
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
