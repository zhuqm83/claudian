import { normalizeCodeBuddySessionModelMetadata } from '@/providers/codebuddy/execution/CodeBuddySessionModelMetadata';

const THOUGHT_LEVEL_OPTIONS = [
  { description: 'Briefest reasoning', name: 'Minimal', value: 'minimal' },
  { description: 'Deep reasoning', name: 'High', value: 'high' },
  { description: 'Use the model default effort', name: 'On (default)', value: 'enabled' },
];

function createSessionResponse() {
  return {
    configOptions: [
      {
        category: 'thought_level',
        currentValue: 'enabled',
        description: 'Choose reasoning effort level for this session',
        id: 'thought_level',
        name: 'Deep Thinking',
        options: THOUGHT_LEVEL_OPTIONS,
        type: 'select' as const,
      },
    ],
    models: {
      availableModels: [
        {
          _meta: {
            maxInputTokens: 1_000_000,
            supportsImages: true,
            supportsReasoning: true,
          },
          description: 'x0.79 credits',
          modelId: 'glm-5.3',
          name: 'GLM-5.3',
        },
        {
          _meta: { maxInputTokens: 168_000, supportsImages: true, supportsReasoning: false },
          modelId: 'auto',
          name: 'Auto',
        },
      ],
      currentModelId: 'glm-5.3',
    },
  };
}

describe('normalizeCodeBuddySessionModelMetadata', () => {
  it('reads models from session/new and attaches advertised reasoning efforts', () => {
    const { currentModelId, models } = normalizeCodeBuddySessionModelMetadata(
      createSessionResponse(),
    );

    expect(currentModelId).toBe('glm-5.3');
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      contextWindow: 1_000_000,
      defaultReasoningEffort: 'enabled',
      description: 'x0.79 credits',
      displayName: 'GLM-5.3',
      rawId: 'glm-5.3',
      reasoningMetadataResolved: true,
      supportsImages: true,
      supportsReasoning: true,
    });
    expect(models[0].reasoningEfforts).toEqual([
      { description: 'Briefest reasoning', label: 'Minimal', value: 'minimal' },
      { description: 'Deep reasoning', label: 'High', value: 'high' },
      { description: 'Use the model default effort', label: 'On (default)', value: 'enabled' },
    ]);
  });

  it('withholds reasoning efforts from models that do not support them', () => {
    const { models } = normalizeCodeBuddySessionModelMetadata(createSessionResponse());
    const auto = models.find(model => model.rawId === 'auto');

    expect(auto).toMatchObject({
      contextWindow: 168_000,
      supportsReasoning: false,
    });
    expect(auto?.reasoningEfforts).toEqual([]);
    expect(auto?.defaultReasoningEffort).toBeUndefined();
  });

  it('returns an empty catalog when the session exposes no models', () => {
    expect(normalizeCodeBuddySessionModelMetadata({})).toEqual({
      currentModelId: null,
      models: [],
    });
  });
});
