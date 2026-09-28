import { ProviderModelUnavailableError } from '../../../core/providers/models/ProviderModelUnavailableError';
import { decodeCodeBuddyModelId } from '../models';
import { getCodeBuddyProviderSettings, getOrderedCodeBuddyVisibleModelIds } from '../settings';

export function assertCodeBuddyModelAvailable(
  settings: Record<string, unknown>,
  requestedModel: string | undefined,
): void {
  const model = requestedModel ?? (typeof settings.model === 'string' ? settings.model : '');
  const config = getCodeBuddyProviderSettings(settings);
  const id = decodeCodeBuddyModelId(model) ?? '';
  if (!(config.enabled && getOrderedCodeBuddyVisibleModelIds(config).includes(id)
    && Boolean(config.currentCatalog?.models.some(candidate => candidate.rawId === id)))) {
    throw new ProviderModelUnavailableError('CodeBuddy');
  }
}
