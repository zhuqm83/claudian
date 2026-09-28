import { CachedProviderCLIResolver } from '../../../core/providers/cli/CachedProviderCLIResolver';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { getCodeBuddyProviderSettings } from '../settings';

export class CodeBuddyCLIResolver {
  private readonly resolver = new CachedProviderCLIResolver({
    binaryName: 'codebuddy',
    getSettingsProjection: (settings) => {
      const providerSettings = getCodeBuddyProviderSettings(settings);
      return {
        cliPathsByHost: providerSettings.cliPathsByHost,
        environmentText: getRuntimeEnvironmentText(settings, 'codebuddy'),
        legacyCliPath: providerSettings.cliPath,
      };
    },
    providerId: 'codebuddy',
  });

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    return this.resolver.resolveFromSettings(settings);
  }

  reset(): void {
    this.resolver.reset();
  }
}
