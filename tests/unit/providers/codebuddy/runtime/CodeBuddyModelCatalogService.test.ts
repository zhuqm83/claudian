import type { ProviderHost } from '@/core/providers/ProviderHost';
import { CodeBuddyModelCatalogService } from '@/providers/codebuddy/runtime/CodeBuddyModelCatalogService';
import { DEFAULT_CODEBUDDY_PROVIDER_SETTINGS } from '@/providers/codebuddy/settings';

function createHost(enabled: boolean): ProviderHost {
  return {
    app: { vault: { adapter: { basePath: '/vault' } } },
    getResolvedProviderCliPath: async () => '/usr/local/bin/codebuddy',
    manifest: { version: '2.3.6' },
    settings: {
      providerConfigs: {
        codebuddy: { ...DEFAULT_CODEBUDDY_PROVIDER_SETTINGS, enabled },
      },
    },
  } as unknown as ProviderHost;
}

describe('CodeBuddyModelCatalogService', () => {
  it('skips discovery while the provider is disabled', async () => {
    const discover = jest.fn();
    const service = new CodeBuddyModelCatalogService(createHost(false), {
      probe: { discover },
    });

    await expect(service.discoverCatalog()).resolves.toEqual({
      kind: 'skipped',
      reason: 'provider-disabled',
    });
    expect(discover).not.toHaveBeenCalled();
  });

  it('reports the probed catalog with a CLI fingerprint', async () => {
    const service = new CodeBuddyModelCatalogService(createHost(true), {
      probe: {
        discover: async () => ({
          currentModelId: 'glm-5.3',
          models: [{
            contextWindow: 1_000_000,
            displayName: 'GLM-5.3',
            rawId: 'glm-5.3',
            reasoningEfforts: [{ label: 'High', value: 'high' }],
            reasoningMetadataResolved: true,
            supportsReasoning: true,
          }],
        }),
      },
    });

    const result = await service.discoverCatalog();

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') throw new Error('expected a completed discovery');
    expect(result.defaultModelId).toBe('glm-5.3');
    expect(result.models.map(model => model.rawId)).toEqual(['glm-5.3']);
    expect(result.fingerprint).toEqual(expect.any(String));
    expect(result.fingerprint.length).toBeGreaterThan(0);
  });

  it('reports diagnostics instead of throwing when the probe fails', async () => {
    const service = new CodeBuddyModelCatalogService(createHost(true), {
      probe: { discover: async () => { throw new Error('boom'); } },
    });

    const result = await service.discoverCatalog();

    expect(result).toMatchObject({
      defaultModelId: null,
      diagnostics: 'CodeBuddy model discovery failed',
      kind: 'completed',
      models: [],
    });
  });
});
