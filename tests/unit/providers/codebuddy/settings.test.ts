import { codeBuddyModelPolicy } from '@/providers/codebuddy/CodeBuddyModelPolicy';
import {
  DEFAULT_CODEBUDDY_PROVIDER_SETTINGS,
  getCodeBuddyProviderSettings,
  getOrderedCodeBuddyVisibleModelIds,
  projectCodeBuddyModelSettings,
  updateCodeBuddyProviderSettings,
} from '@/providers/codebuddy/settings';
import { getHostnameKey } from '@/utils/env';

const CATALOG_MODELS = [
  {
    contextWindow: 1_000_000,
    description: 'x0.79 credits',
    displayName: 'GLM-5.3',
    rawId: 'glm-5.3',
    reasoningEfforts: [
      { label: 'Low', value: 'low' },
      { label: 'High', value: 'high' },
    ],
    supportsReasoning: true,
  },
  {
    displayName: 'Auto',
    rawId: 'auto',
    reasoningEfforts: [],
    supportsReasoning: false,
  },
];

function createSettings(): Record<string, unknown> {
  return {
    providerConfigs: {
      codebuddy: { ...DEFAULT_CODEBUDDY_PROVIDER_SETTINGS },
    },
  };
}

function seedCatalog(settings: Record<string, unknown>): void {
  updateCodeBuddyProviderSettings(settings, {
    catalogsByHost: {
      [getHostnameKey()]: {
        defaultModelId: 'glm-5.3',
        fingerprint: 'fp-1',
        models: CATALOG_MODELS,
        refreshedAt: 1,
      },
    },
  });
}

function selectModels(settings: Record<string, unknown>, visibleModels: string[]): void {
  updateCodeBuddyProviderSettings(settings, { visibleModels });
}

function rawCodeBuddyConfig(settings: Record<string, unknown>): Record<string, unknown> {
  return (settings.providerConfigs as Record<string, Record<string, unknown>>).codebuddy;
}

describe('codebuddy provider settings', () => {
  it('defaults to disabled with an empty catalog', () => {
    const config = getCodeBuddyProviderSettings(createSettings());

    expect(config.enabled).toBe(false);
    expect(config.cliPath).toBe('');
    expect(config.currentCatalog).toBeNull();
    expect(config.visibleModels).toEqual([]);
  });

  it('decodes malformed persisted scalars instead of trusting them', () => {
    const config = getCodeBuddyProviderSettings({
      providerConfigs: {
        codebuddy: {
          cliPath: 7,
          enabled: 'false',
          environmentHash: false,
          environmentVariables: ['SECRET=value'],
        },
      },
    });

    expect(config.enabled).toBe(false);
    expect(config.cliPath).toBe('');
    expect(config.environmentHash).toBe('');
    expect(config.environmentVariables).toEqual(expect.any(String));
  });

  it('stores per-host CLI paths without keeping the legacy field', () => {
    const settings = createSettings();
    updateCodeBuddyProviderSettings(settings, { cliPath: '/usr/local/bin/codebuddy' });

    const config = getCodeBuddyProviderSettings(settings);
    expect(config.cliPath).toBe('');
    expect(Object.values(config.cliPathsByHost)).toContain('/usr/local/bin/codebuddy');
  });

  it('falls back to the advertised default model when no explicit selection exists', () => {
    const settings = createSettings();
    seedCatalog(settings);
    rawCodeBuddyConfig(settings).visibleModels = null;

    expect(getOrderedCodeBuddyVisibleModelIds(getCodeBuddyProviderSettings(settings)))
      .toEqual(['glm-5.3', 'auto']);
  });

  it('honours an explicit selection order over the advertised default', () => {
    const settings = createSettings();
    seedCatalog(settings);
    selectModels(settings, ['auto', 'glm-5.3']);

    expect(getOrderedCodeBuddyVisibleModelIds(getCodeBuddyProviderSettings(settings)))
      .toEqual(['auto', 'glm-5.3']);
  });

  it('projects only durable model settings for persistence', () => {
    const settings = createSettings();
    seedCatalog(settings);
    selectModels(settings, ['glm-5.3', 'auto']);

    const projected = projectCodeBuddyModelSettings(settings);

    expect(projected).not.toHaveProperty('catalogsByHost');
    expect(projected).not.toHaveProperty('currentCatalog');
    expect(projected.visibleModels).toEqual(['glm-5.3', 'auto']);
    expect(projected.selectedModelsByHost).toBeDefined();
  });
});

describe('codebuddy model policy', () => {
  it('exposes only selected models as namespaced options', () => {
    const settings = createSettings();
    seedCatalog(settings);
    selectModels(settings, ['glm-5.3', 'auto']);

    expect(codeBuddyModelPolicy.getModelOptions(settings)).toEqual([
      {
        description: 'x0.79 credits',
        label: 'GLM-5.3',
        value: 'codebuddy/glm-5.3',
      },
      { label: 'Auto', value: 'codebuddy/auto' },
    ]);
    expect(codeBuddyModelPolicy.ownsModel('codebuddy/glm-5.3', settings)).toBe(true);
    expect(codeBuddyModelPolicy.ownsModel('grok/glm-5.3', settings)).toBe(false);
  });

  it('hides discovered models that were never selected', () => {
    const settings = createSettings();
    seedCatalog(settings);
    selectModels(settings, ['auto']);

    expect(codeBuddyModelPolicy.getModelOptions(settings))
      .toEqual([{ label: 'Auto', value: 'codebuddy/auto' }]);
  });

  it('reports reasoning options only for models that advertise them', () => {
    const settings = createSettings();
    seedCatalog(settings);
    selectModels(settings, ['glm-5.3', 'auto']);

    expect(codeBuddyModelPolicy.isAdaptiveReasoningModel('codebuddy/glm-5.3', settings)).toBe(true);
    expect(codeBuddyModelPolicy.getReasoningOptions('codebuddy/glm-5.3', settings)).toEqual([
      { label: 'Low', value: 'low' },
      { label: 'High', value: 'high' },
    ]);
    expect(codeBuddyModelPolicy.isAdaptiveReasoningModel('codebuddy/auto', settings)).toBe(false);
    expect(codeBuddyModelPolicy.getReasoningOptions('codebuddy/auto', settings)).toEqual([]);
  });

  it('persists an explicitly selected reasoning effort per model', () => {
    const settings = createSettings();
    seedCatalog(settings);
    selectModels(settings, ['glm-5.3']);

    codeBuddyModelPolicy.applyReasoningSelection?.('codebuddy/glm-5.3', 'high', settings);

    expect(getCodeBuddyProviderSettings(settings).preferredReasoningByModel).toEqual({
      'glm-5.3': 'high',
    });
  });

  it('drops a stored reasoning effort the model no longer advertises', () => {
    const settings = createSettings();
    seedCatalog(settings);
    selectModels(settings, ['glm-5.3']);
    codeBuddyModelPolicy.applyReasoningSelection?.('codebuddy/glm-5.3', 'high', settings);

    codeBuddyModelPolicy.applyReasoningSelection?.('codebuddy/glm-5.3', 'max', settings);

    expect(getCodeBuddyProviderSettings(settings).preferredReasoningByModel).toEqual({});
  });

  it('maps the shared permission mode onto Safe/YOLO', () => {
    const settings: Record<string, unknown> = { permissionMode: 'normal' };
    expect(codeBuddyModelPolicy.resolvePermissionMode?.(settings)).toBe('normal');

    codeBuddyModelPolicy.applyPermissionMode?.('yolo', settings);
    expect(settings.permissionMode).toBe('yolo');
    expect(codeBuddyModelPolicy.resolvePermissionMode?.(settings)).toBe('yolo');
  });
});
