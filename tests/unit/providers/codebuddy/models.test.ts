import {
  decodeCodeBuddyModelId,
  encodeCodeBuddyModelId,
  findCodeBuddyModel,
  getCodeBuddyAvailableReasoningEfforts,
  isCodeBuddyModelSelectionId,
  mergeCodeBuddyDiscoveredModels,
  normalizeCodeBuddyDiscoveredModels,
  normalizeCodeBuddyReasoningEfforts,
  resolveCodeBuddyDefaultReasoningEffort,
} from '@/providers/codebuddy/models';

describe('codebuddy models', () => {
  describe('model selection ids', () => {
    it('round-trips a namespaced model id', () => {
      expect(encodeCodeBuddyModelId('glm-5.3')).toBe('codebuddy/glm-5.3');
      expect(encodeCodeBuddyModelId('codebuddy/glm-5.3')).toBe('codebuddy/glm-5.3');
      expect(decodeCodeBuddyModelId('codebuddy/glm-5.3')).toBe('glm-5.3');
      expect(isCodeBuddyModelSelectionId('codebuddy/glm-5.3')).toBe(true);
    });

    it('rejects unprefixed and empty selections', () => {
      expect(encodeCodeBuddyModelId('   ')).toBe('');
      expect(decodeCodeBuddyModelId('glm-5.3')).toBeNull();
      expect(decodeCodeBuddyModelId('codebuddy/')).toBeNull();
      expect(isCodeBuddyModelSelectionId('grok/glm-5.3')).toBe(false);
    });
  });

  describe('discovered models', () => {
    it('normalizes ACP model metadata into a discovered model', () => {
      const models = normalizeCodeBuddyDiscoveredModels([{
        description: 'x0.79 credits',
        displayName: 'GLM-5.3',
        maxInputTokens: 1_000_000,
        rawId: 'glm-5.3',
        supportsImages: true,
        supportsReasoning: true,
      }]);

      expect(models).toEqual([{
        contextWindow: 1_000_000,
        description: 'x0.79 credits',
        displayName: 'GLM-5.3',
        rawId: 'glm-5.3',
        reasoningEfforts: [],
        supportsImages: true,
        supportsReasoning: true,
      }]);
    });

    it('drops entries without an id and keeps the richest metadata when merging', () => {
      const merged = mergeCodeBuddyDiscoveredModels(
        [{
          contextWindow: 200_000,
          displayName: 'hy3',
          rawId: 'hy3',
          reasoningEfforts: [{ label: 'High', value: 'high' }],
          supportsReasoning: true,
        }],
        [{
          description: 'x0.00 credits',
          displayName: 'Hy3',
          rawId: 'hy3',
          reasoningEfforts: [],
          supportsReasoning: false,
        }],
      );

      expect(merged).toHaveLength(1);
      expect(merged[0]).toMatchObject({
        contextWindow: 200_000,
        description: 'x0.00 credits',
        displayName: 'Hy3',
        supportsReasoning: true,
      });
      expect(merged[0].reasoningEfforts).toEqual([{ label: 'High', value: 'high' }]);
      expect(normalizeCodeBuddyDiscoveredModels([{ displayName: 'no id' }])).toEqual([]);
    });

    it('finds a model by raw or namespaced id', () => {
      const models = normalizeCodeBuddyDiscoveredModels([
        { displayName: 'Auto', rawId: 'auto' },
      ]);
      expect(findCodeBuddyModel(models, 'codebuddy/auto')?.displayName).toBe('Auto');
      expect(findCodeBuddyModel(models, 'auto')?.rawId).toBe('auto');
      expect(findCodeBuddyModel(models, 'missing')).toBeNull();
    });
  });

  describe('reasoning efforts', () => {
    it('orders advertised efforts and drops duplicates', () => {
      expect(normalizeCodeBuddyReasoningEfforts([
        { name: 'High', value: 'high' },
        { name: 'Minimal', value: 'minimal' },
        { name: 'Duplicate', value: 'high' },
        { name: 'Max', value: 'max' },
      ])).toEqual([
        { label: 'Minimal', value: 'minimal' },
        { label: 'High', value: 'high' },
        { label: 'Max', value: 'max' },
      ]);
    });

    it('only exposes efforts for models that support reasoning', () => {
      const withReasoning = {
        displayName: 'Hy4 preview',
        rawId: 'hy4-preview',
        reasoningEfforts: [{ label: 'High', value: 'high' }],
        supportsReasoning: true,
      };
      const withoutReasoning = {
        displayName: 'Auto',
        rawId: 'auto',
        reasoningEfforts: [{ label: 'High', value: 'high' }],
        supportsReasoning: false,
      };

      expect(getCodeBuddyAvailableReasoningEfforts(withReasoning)).toHaveLength(1);
      expect(getCodeBuddyAvailableReasoningEfforts(withoutReasoning)).toEqual([]);
      expect(getCodeBuddyAvailableReasoningEfforts(null)).toEqual([]);
    });

    it('prefers a supported stored preference, then the advertised default', () => {
      const model = {
        defaultReasoningEffort: 'medium',
        displayName: 'Hy4 preview',
        rawId: 'hy4-preview',
        reasoningEfforts: [
          { label: 'Low', value: 'low' },
          { label: 'Medium', value: 'medium' },
          { label: 'High', value: 'high' },
        ],
        supportsReasoning: true,
      };

      expect(resolveCodeBuddyDefaultReasoningEffort(model, 'low')).toBe('low');
      expect(resolveCodeBuddyDefaultReasoningEffort(model, 'unsupported')).toBe('medium');
      expect(resolveCodeBuddyDefaultReasoningEffort(model)).toBe('medium');
      expect(resolveCodeBuddyDefaultReasoningEffort(null)).toBe('');
    });
  });
});
