import type {
  ProviderModelPolicy,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../core/providers/types';
import {
  decodeCodeBuddyModelId,
  encodeCodeBuddyModelId,
  findCodeBuddyModel,
  getCodeBuddyAvailableReasoningEfforts,
  isCodeBuddyModelSelectionId,
  resolveCodeBuddyDefaultReasoningEffort,
} from './models';
import {
  getCodeBuddyProviderSettings,
  getOrderedCodeBuddyVisibleModelIds,
  updateCodeBuddyProviderSettings,
} from './settings';

export const codeBuddyModelPolicy: ProviderModelPolicy = {
  permissionModes: { inactiveValue: 'normal', activeValue: 'yolo' },

  getModelOptions(settings): ProviderUIOption[] {
    const codeBuddySettings = getCodeBuddyProviderSettings(settings);
    const catalogModels = codeBuddySettings.currentCatalog?.models ?? [];
    const catalogById = new Map(catalogModels.map(model => [model.rawId, model] as const));
    const options: ProviderUIOption[] = [];
    const seen = new Set<string>();

    for (const rawId of getOrderedCodeBuddyVisibleModelIds(codeBuddySettings)) {
      const value = encodeCodeBuddyModelId(rawId);
      if (!value || seen.has(value)) {
        continue;
      }
      seen.add(value);
      const model = catalogById.get(rawId);
      if (!model) {
        continue;
      }
      options.push({
        value,
        label: codeBuddySettings.modelAliases[rawId] ?? model.displayName,
        ...(model.description ? { description: model.description } : {}),
      });
    }

    return options;
  },

  getDefaultModel(settings): string | null {
    const codeBuddySettings = getCodeBuddyProviderSettings(settings);
    const firstVisibleModelId = getOrderedCodeBuddyVisibleModelIds(codeBuddySettings)
      .find(id => codeBuddySettings.currentCatalog?.models.some(model => model.rawId === id));
    return firstVisibleModelId ? encodeCodeBuddyModelId(firstVisibleModelId) : null;
  },

  ownsModel(model): boolean {
    return isCodeBuddyModelSelectionId(model);
  },

  isAdaptiveReasoningModel(model, settings): boolean {
    return getCodeBuddyAvailableReasoningEfforts(
      getExplicitlySelectedCodeBuddyModel(model, settings),
    ).length > 0;
  },

  getReasoningOptions(model, settings): ProviderReasoningOption[] {
    return getCodeBuddyAvailableReasoningEfforts(
      getExplicitlySelectedCodeBuddyModel(model, settings),
    ).map(option => ({
      ...(option.description ? { description: option.description } : {}),
      label: option.label,
      value: option.value,
    }));
  },

  getDefaultReasoningValue(model, settings): string {
    const codeBuddySettings = getCodeBuddyProviderSettings(settings);
    const rawId = decodeCodeBuddyModelId(model);
    if (!rawId) {
      return '';
    }
    const selectedModel = getExplicitlySelectedCodeBuddyModel(model, settings);
    if (getCodeBuddyAvailableReasoningEfforts(selectedModel).length === 0) {
      return '';
    }
    return resolveCodeBuddyDefaultReasoningEffort(
      selectedModel,
      codeBuddySettings.preferredReasoningByModel[rawId],
    );
  },

  isDefaultModel(): boolean {
    return false;
  },

  applyModelDefaults(model, settings): void {
    if (!isRecord(settings)) {
      return;
    }
    const normalizedModel = normalizeSelection(model);
    if (!isCodeBuddyModelSelectionId(normalizedModel)) {
      return;
    }
    clearSavedCodeBuddyEffortProjection(settings);
    settings.model = normalizedModel;
    settings.effortLevel = this.getDefaultReasoningValue(normalizedModel, settings);
  },

  applyModelProjectionDefaults(model, settings): void {
    if (!isRecord(settings)) {
      return;
    }
    clearSavedCodeBuddyEffortProjection(settings);
    if (!decodeCodeBuddyModelId(model)) {
      delete settings.effortLevel;
      return;
    }
    settings.effortLevel = this.getDefaultReasoningValue(model, settings);
  },

  applyReasoningSelection(model, value, settings): void {
    if (!isRecord(settings)) {
      return;
    }
    const rawId = decodeCodeBuddyModelId(model);
    if (!rawId) {
      clearSavedCodeBuddyEffortProjection(settings);
      delete settings.effortLevel;
      return;
    }
    const codeBuddySettings = getCodeBuddyProviderSettings(settings);
    const supportedValues = new Set(getCodeBuddyAvailableReasoningEfforts(
      getExplicitlySelectedCodeBuddyModel(model, settings),
    ).map(option => option.value));
    const preferredReasoningByModel = { ...codeBuddySettings.preferredReasoningByModel };
    if (supportedValues.has(value)) {
      preferredReasoningByModel[rawId] = value;
    } else {
      delete preferredReasoningByModel[rawId];
    }
    updateCodeBuddyProviderSettings(settings, { preferredReasoningByModel });
  },

  normalizeModelVariant(model): string {
    return normalizeSelection(model);
  },

  getCustomModelIds(): Set<string> {
    return new Set();
  },

  resolvePermissionMode(settings): string {
    return settings.permissionMode === 'yolo' ? 'yolo' : 'normal';
  },

  applyPermissionMode(value, settings): void {
    if (isRecord(settings)) {
      settings.permissionMode = value === 'yolo' ? 'yolo' : 'normal';
    }
  },
};

function normalizeSelection(model: string): string {
  const normalized = model.trim();
  const rawId = decodeCodeBuddyModelId(normalized);
  return rawId ? encodeCodeBuddyModelId(rawId) : model;
}

function getExplicitlySelectedCodeBuddyModel(
  model: string,
  settings: Record<string, unknown>,
) {
  const rawId = decodeCodeBuddyModelId(model);
  if (!rawId) {
    return null;
  }
  const codeBuddySettings = getCodeBuddyProviderSettings(settings);
  const catalogModels = codeBuddySettings.currentCatalog?.models ?? [];
  const visibleModels = codeBuddySettings.visibleModels
    ?? catalogModels.map(entry => entry.rawId);
  if (!visibleModels.includes(rawId)) {
    return null;
  }
  return findCodeBuddyModel(catalogModels, rawId) ?? {
    displayName: rawId,
    rawId,
    reasoningEfforts: [],
    supportsReasoning: false,
  };
}

function clearSavedCodeBuddyEffortProjection(settings: Record<string, unknown>): void {
  if (isRecord(settings.savedProviderEffort)) {
    delete settings.savedProviderEffort.codebuddy;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
