// A workspace over the fake API, loaded through the same module graph as the screens. Helper, not a test.
import { createFakeRequest, defaultRoutes } from './apiFixtures.js';
import { load, memoryStorage } from './render.js';

export async function setupWorkspace(overrides = {}, storage = memoryStorage()) {
  const { createMedrippleClient, createTokenStore } = await load('/src/services/medrippleClient.js');
  const { createWorkspace } = await load('/src/services/workspace.js');
  const fake = createFakeRequest(defaultRoutes(overrides));
  const tokens = createTokenStore(memoryStorage());
  tokens.set('session-token');
  const api = createMedrippleClient(fake.request, tokens);
  return { fake, api, storage, tokens, workspace: createWorkspace({ api, storage }) };
}
