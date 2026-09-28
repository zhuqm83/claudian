import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { CodeBuddyCommandCatalog } from '../commands/CodeBuddyCommandCatalog';
import { CodeBuddyCLIResolver } from '../runtime/CodeBuddyCLIResolver';
import { CodeBuddyModelCatalogCoordinator } from '../runtime/CodeBuddyModelCatalogCoordinator';
import { CodeBuddyModelCatalogService } from '../runtime/CodeBuddyModelCatalogService';
import { createCodeBuddyModels } from '../runtime/CodeBuddyModels';
import { codeBuddySettingsTabRenderer } from '../ui/CodeBuddySettingsTab';

export interface CodeBuddyWorkspaceServices extends ProviderWorkspaceServices {
  cliResolver: CodeBuddyCLIResolver;
  commandCatalog: ProviderCommandCatalog;
  modelCatalogCoordinator: CodeBuddyModelCatalogCoordinator;
  dispose(): Promise<void>;
}

export async function createCodeBuddyWorkspaceServices(
  plugin: ProviderHost,
): Promise<CodeBuddyWorkspaceServices> {
  const modelCatalogService = new CodeBuddyModelCatalogService(plugin);
  const modelCatalogCoordinator = new CodeBuddyModelCatalogCoordinator(
    plugin,
    modelCatalogService,
  );
  const modelCatalog = createCodeBuddyModels(plugin, modelCatalogCoordinator);
  const unregisterTransitionHook =
    plugin.executionLifecycleRegistry.registerTransitionHook('codebuddy', {
      beforeTransition: async () => {
        modelCatalog.beginTransition();
        modelCatalogCoordinator.beginEnvironmentTransition();
        await modelCatalogCoordinator.quiesceForEnvironmentChange();
      },
      afterTransition: async () => {
        try {
          await modelCatalogCoordinator.quiesceForEnvironmentChange();
        } finally {
          modelCatalogCoordinator.endEnvironmentTransition();
          modelCatalog.endTransition();
        }
      },
    });

  return {
    cliResolver: new CodeBuddyCLIResolver(),
    commandCatalog: new CodeBuddyCommandCatalog(),
    modelCatalogCoordinator,
    modelCatalog,
    settingsTabRenderer: codeBuddySettingsTabRenderer,
    async dispose() {
      unregisterTransitionHook();
      await modelCatalogCoordinator.dispose();
      await modelCatalog.dispose();
    },
  };
}

export const codeBuddyWorkspaceRegistration: ProviderWorkspaceRegistration<CodeBuddyWorkspaceServices> = {
  initialize: async ({ plugin }) => createCodeBuddyWorkspaceServices(plugin),
};

export function getCodeBuddyWorkspaceServices(): CodeBuddyWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('codebuddy') as CodeBuddyWorkspaceServices;
}
