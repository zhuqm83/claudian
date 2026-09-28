import type { ProviderCapabilities } from '../../core/providers/types';

export const CODEBUDDY_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'codebuddy',
  supportsNativeHistory: false,
  supportsEphemeralSessions: false,
  supportsRewind: false,
  supportsFork: false,
  supportsProviderCommands: true,
  supportsImageAttachments: true,
  supportsTurnSteer: false,
  supportsResponseThroughput: false,
  reasoningControl: 'effort',
});
