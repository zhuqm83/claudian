import { ProviderModelCatalogController } from '../../../core/providers/models/ProviderModelCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import {
  getCodeBuddyProviderSettings,
  getOrderedCodeBuddyVisibleModelIds,
  updateCodeBuddyProviderSettings,
} from '../settings';
import type { CodeBuddyModelCatalogCoordinator } from './CodeBuddyModelCatalogCoordinator';

export function createCodeBuddyModels(
  host: ProviderHost,
  native: Pick<CodeBuddyModelCatalogCoordinator, 'refresh'>,
): ProviderModelCatalogController {
  return new ProviderModelCatalogController({
    providerId: 'codebuddy',
    host,
    update: updateCodeBuddyProviderSettings,
    providerName: 'CodeBuddy',
    read: (settings = host.settings) => {
      const current = getCodeBuddyProviderSettings(settings);
      return {
        enabled: current.enabled,
        models: (current.currentCatalog?.models ?? []).map(model => ({
          id: model.rawId,
          name: model.displayName,
          description: model.description,
        })),
        selectedIds: getOrderedCodeBuddyVisibleModelIds(current),
        aliases: current.modelAliases,
      };
    },
    discover: async signal => {
      const result = await native.refresh(undefined, signal);
      return { changed: result.changed, diagnostics: result.diagnostics };
    },
  });
}
