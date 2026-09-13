const { AppError } = require('./errors');

function validateIntelligenceResponse(payload) {
  if (!payload || typeof payload !== 'object' || !payload.risk || !payload.forecast) {
    throw new Error('The intelligence response is missing forecast or risk data.');
  }
  if (!Number.isFinite(payload.risk.score) || typeof payload.risk.label !== 'string') {
    throw new Error('The intelligence response contains an invalid risk object.');
  }
  return payload;
}

async function createFallbackForecast({ facilityId, medicineId, horizonDays }, inventoryStore) {
  const profile = await inventoryStore.getScenarioProfile(facilityId, medicineId);
  if (!profile) {
    throw new AppError(404, 'FORECAST_TARGET_NOT_FOUND', 'The requested facility or medicine was not found.');
  }
  const source = inventoryStore.source === 'MYSQL' ? 'DATABASE_FALLBACK' : 'FIXTURE_FALLBACK';
  return {
    forecast: {
      dailyDemand: profile.dailyDemand,
      lowerBound: Math.max(0, profile.dailyDemand * 0.9),
      upperBound: profile.dailyDemand * 1.1,
      horizonDays
    },
    risk: { score: profile.riskScore, label: profile.riskLabel },
    stockout: { daysRemaining: profile.daysRemaining, projectedWithinHorizon: profile.daysRemaining <= horizonDays },
    confidence: { label: 'LOW', reason: 'Deterministic fallback; awaiting the tested intelligence service.' },
    cause: profile.incomingArrivalDay && profile.incomingArrivalDay > profile.daysRemaining ? 'SUPPLY_DELAY' : 'INVENTORY_IMBALANCE',
    explanation: profile.incomingArrivalDay && profile.incomingArrivalDay > profile.daysRemaining
      ? 'Simulated stock will deplete before the scheduled replenishment arrives.'
      : 'Simulated coverage is based on effective stock and daily demand.',
    source,
    isFallback: true,
    decisionSupportOnly: true
  };
}

function createIntelligenceAdapter(config, inventoryStore) {
  return {
    async forecast(input) {
      if (!config.intelligenceServiceUrl) return createFallbackForecast(input, inventoryStore);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.intelligenceTimeoutMs);
      try {
        const response = await fetch(`${config.intelligenceServiceUrl}/forecast`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`Intelligence service returned ${response.status}.`);
        const payload = validateIntelligenceResponse(await response.json());
        return { ...payload, source: 'INTELLIGENCE_SERVICE', decisionSupportOnly: true };
      } catch (error) {
        return {
          ...(await createFallbackForecast(input, inventoryStore)),
          fallbackReason: error.name === 'AbortError' ? 'INTELLIGENCE_TIMEOUT' : 'INTELLIGENCE_UNAVAILABLE'
        };
      } finally {
        clearTimeout(timeout);
      }
    }
  };
}

module.exports = { createIntelligenceAdapter, validateIntelligenceResponse, createFallbackForecast };
