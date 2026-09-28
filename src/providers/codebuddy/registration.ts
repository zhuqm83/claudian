import { NOOP_TASK_RESULT_INTERPRETER } from '../../core/providers/NoopTaskResultInterpreter';
import { getProviderConfig } from '../../core/providers/providerConfig';
import { hasStoredConfigNormalization } from '../../core/providers/settings/storedSettings';
import type { ProviderModule } from '../../core/providers/types';
import {
  codeBuddyWorkspaceRegistration,
  getCodeBuddyWorkspaceServices,
} from './app/CodeBuddyWorkspaceServices';
import { CODEBUDDY_PROVIDER_CAPABILITIES } from './capabilities';
import { codeBuddyModelPolicy } from './CodeBuddyModelPolicy';
import { codeBuddySettingsReconciler } from './env/CodeBuddySettingsReconciler';
import { CodeBuddyExecutionBackend } from './execution/CodeBuddyExecutionBackend';
import { CodeBuddyConversationHistoryService } from './history/CodeBuddyConversationHistoryService';
import {
  getCodeBuddyMigratedVisibleModelIds,
  getCodeBuddyProviderSettings,
  getOrderedCodeBuddyVisibleModelIds,
  projectCodeBuddyModelSettings,
  updateCodeBuddyProviderSettings,
} from './settings';
import { codeBuddyChatUIConfig } from './ui/CodeBuddyChatUIConfig';

export const codeBuddyProviderRegistration: ProviderModule = {
  id: 'codebuddy',
  displayName: 'CodeBuddy',
  blankTabOrder: 13,
  isEnabled: settings => getCodeBuddyProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => updateCodeBuddyProviderSettings(settings, { enabled }),
  capabilities: CODEBUDDY_PROVIDER_CAPABILITIES,
  environmentKeyPatterns: [/^CODEBUDDY_/i],
  modelPolicy: codeBuddyModelPolicy,
  chatUIConfig: codeBuddyChatUIConfig,
  settingsReconciler: codeBuddySettingsReconciler,
  settingsStorage: {
    projectPersistedConfig: projectCodeBuddyModelSettings,
    needsReasoningMetadata(settings) {
      const current = getCodeBuddyProviderSettings(settings);
      return getOrderedCodeBuddyVisibleModelIds(current).some(id => {
        const model = current.currentCatalog?.models.find(entry => entry.rawId === id);
        return !model || (!model.reasoningEfforts.length && !model.reasoningMetadataResolved);
      });
    },
    hostScopedFields: ['cliPathsByHost', 'catalogsByHost', 'selectedModelsByHost'],
    normalizeStored(target, stored) {
      const storedConfig = getProviderConfig(stored, 'codebuddy');
      const current = getCodeBuddyProviderSettings(stored);
      updateCodeBuddyProviderSettings(target, {
        ...current,
        visibleModels: getCodeBuddyMigratedVisibleModelIds(current),
      });
      return hasStoredConfigNormalization(
        storedConfig,
        getProviderConfig(target, 'codebuddy'),
      );
    },
  },
  createExecutionBackend: (plugin) => {
    const workspace = getCodeBuddyWorkspaceServices();
    return new CodeBuddyExecutionBackend(plugin, {
      commandCatalog: workspace.commandCatalog,
      modelCatalogCoordinator: workspace.modelCatalogCoordinator,
    });
  },
  historyService: new CodeBuddyConversationHistoryService(),
  taskResultInterpreter: NOOP_TASK_RESULT_INTERPRETER,
  workspace: codeBuddyWorkspaceRegistration,
};
