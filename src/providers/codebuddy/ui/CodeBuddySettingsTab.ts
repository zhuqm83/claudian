import * as fs from 'node:fs';
import * as path from 'node:path';

import { Setting } from 'obsidian';

import { probeCLIInstallation } from '@/core/providers/cli/CLIInstallationProbe';
import { getRuntimeEnvironmentVariables } from '@/core/providers/providerEnvironment';
import { CODEBUDDY_PROVIDER_ICON } from '@/shared/icons';
import { renderCLIInstallationSetting } from '@/shared/settings/CLIInstallationSetting';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type { ProviderSettingsTabRenderer } from '../../../core/providers/types';
import type { ClaudianSettings } from '../../../core/types';
import { t } from '../../../i18n/i18n';
import { renderEnvironmentSettingsSection } from '../../../shared/settings/EnvironmentSettingsSection';
import type { ProviderEnablementSettingOptions } from '../../../shared/settings/ProviderEnablementSetting';
import {
  renderLastEnabledProviderWarning,
  renderProviderModelEnablementWarning,
} from '../../../shared/settings/ProviderModelEnablementWarning';
import { renderProviderModelsSection } from '../../../shared/settings/ProviderModelsSection';
import { getHostnameKey } from '../../../utils/env';
import { normalizeConfiguredCLIPath } from '../../../utils/path';
import type { CodeBuddyWorkspaceServices } from '../app/CodeBuddyWorkspaceServices';
import { getCodeBuddyProviderSettings, updateCodeBuddyProviderSettings } from '../settings';

const CODEBUDDY_PROVIDER_ID = 'codebuddy' as const;
const CODEBUDDY_DISPLAY_NAME = 'CodeBuddy';

export const codeBuddySettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const hostnameKey = getHostnameKey();
    const workspace = getCodeBuddyWorkspaceServices();

    const enablement: Omit<ProviderEnablementSettingOptions, 'container' | 'description'> = {
      getValue: () => getCodeBuddyProviderSettings(settingsBag).enabled,
      name: t('settings.providerEnablement.name', { provider: CODEBUDDY_DISPLAY_NAME }),
      onChange: async (enabled) => {
        if (!ProviderSettingsCoordinator.canApplyProviderEnablement(
          settingsBag,
          CODEBUDDY_PROVIDER_ID,
          enabled,
        )) {
          lastProviderWarning.showFor();
          return;
        }

        let accepted = true;
        await context.plugin.runProviderExecutionTransition(
          [CODEBUDDY_PROVIDER_ID],
          async () => context.plugin.mutateSettings((settings) => {
            accepted = ProviderSettingsCoordinator.applyProviderEnablement(
              settings,
              CODEBUDDY_PROVIDER_ID,
              enabled,
            );
          }),
        );
        if (accepted) {
          lastProviderWarning.hide();
        } else {
          lastProviderWarning.showFor();
        }
        modelWarning.context.notifyProviderModelOptionsChanged(CODEBUDDY_PROVIDER_ID);
      },
    };

    const installationContainer = container.createDiv();
    const lastProviderWarning = renderLastEnabledProviderWarning(container);

    const modelWarning = renderProviderModelEnablementWarning(container, context, {
      getHasEnabledModels: () => {
        const current = getCodeBuddyProviderSettings(settingsBag);
        return (current.visibleModels ?? current.currentCatalog?.models ?? []).length > 0;
      },
      getIsEnabled: () => getCodeBuddyProviderSettings(settingsBag).enabled,
      providerId: CODEBUDDY_PROVIDER_ID,
      providerName: CODEBUDDY_DISPLAY_NAME,
    });

    renderCLIInstallationSetting({
      cliName: 'CodeBuddy CLI',
      container: installationContainer,
      enablement,
      getValue: () => {
        const current = getCodeBuddyProviderSettings(settingsBag);
        return current.cliPathsByHost[hostnameKey] ?? current.cliPath ?? '';
      },
      icon: CODEBUDDY_PROVIDER_ICON,
      inspect: async () => {
        const settings = context.plugin.settings as unknown as Record<string, unknown>;
        const config = getCodeBuddyProviderSettings(settings);
        return probeCLIInstallation({
          args: ['--version'],
          configuredPath: config.cliPathsByHost[hostnameKey] || config.cliPath,
          env: { ...process.env, ...getRuntimeEnvironmentVariables(settings, 'codebuddy') },
          path: await context.plugin.getResolvedProviderCliPath('codebuddy'),
        });
      },
      name: 'CLI path',
      onChange: async (value) => {
        const cliPathsByHost = {
          ...getCodeBuddyProviderSettings(settingsBag).cliPathsByHost,
        };
        if (value) {
          cliPathsByHost[hostnameKey] = value;
        } else {
          delete cliPathsByHost[hostnameKey];
        }
        const mutation = (settings: ClaudianSettings): void => {
          updateCodeBuddyProviderSettings(settings, {
            cliPath: '',
            cliPathsByHost,
          });
        };
        await context.plugin.applyProviderRuntimeSettings(
          [CODEBUDDY_PROVIDER_ID],
          mutation,
          () => workspace.cliResolver.reset(),
        );
        modelWarning.context.notifyProviderModelOptionsChanged(CODEBUDDY_PROVIDER_ID);
      },
      placeholder: process.platform === 'win32'
        ? 'C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy'
        : '/usr/local/bin/codebuddy',
      validate: validateCLIPath,
    });

    new Setting(container).setName('Models').setHeading();
    const modelPicker = renderProviderModelsSection(
      container,
      CODEBUDDY_PROVIDER_ID,
      CODEBUDDY_DISPLAY_NAME,
      workspace.modelCatalog!,
      () => modelWarning.refresh(),
    );

    new Setting(container).setName(t('settings.agentSkills.sectionTitle')).setHeading();
    context.renderAgentSkillSettings(container, CODEBUDDY_PROVIDER_ID);

    new Setting(container).setName('Commands').setHeading();
    context.renderHiddenProviderCommandSetting(container, CODEBUDDY_PROVIDER_ID, {
      desc: 'Hide runtime commands advertised by CodeBuddy from the command dropdown. Enter names without the leading slash, one per line.',
      name: 'Hidden CodeBuddy commands',
      placeholder: 'compact\nreview',
    });

    renderEnvironmentSettingsSection({
      container,
      desc: 'Environment variables passed only to CodeBuddy.',
      heading: 'Environment',
      name: 'CodeBuddy environment variables',
      placeholder: 'CODEBUDDY_HOME=/path/to/codebuddy-home',
      plugin: context.plugin,
      renderCustomContextLimits: target => context.renderCustomContextLimits(target, CODEBUDDY_PROVIDER_ID),
      scope: 'provider:codebuddy',
    });
    return modelPicker;
  },
};

function validateCLIPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const expandedPath = normalizeConfiguredCLIPath(trimmed);
  if (!path.posix.isAbsolute(expandedPath) && !path.win32.isAbsolute(expandedPath)) {
    return 'Path must be absolute';
  }
  try {
    if (!fs.existsSync(expandedPath)) {
      return 'Path does not exist';
    }
    if (!fs.statSync(expandedPath).isFile()) {
      return 'Path must point to a file';
    }
    if (process.platform !== 'win32') {
      fs.accessSync(expandedPath, fs.constants.X_OK);
    }
  } catch {
    return process.platform === 'win32'
      ? 'Path is not accessible'
      : 'Path must be executable';
  }
  return null;
}

function getCodeBuddyWorkspaceServices(): CodeBuddyWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices(CODEBUDDY_PROVIDER_ID) as CodeBuddyWorkspaceServices;
}
