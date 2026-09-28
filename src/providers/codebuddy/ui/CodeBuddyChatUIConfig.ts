import type { ProviderChatUIConfig } from '../../../core/providers/types';
import { CODEBUDDY_PROVIDER_ICON } from '../../../shared/icons';
import { codeBuddyModelPolicy } from '../CodeBuddyModelPolicy';

export const codeBuddyChatUIConfig: ProviderChatUIConfig = {
  ...codeBuddyModelPolicy,
  getPermissionModeToggle() {
    return { ...codeBuddyModelPolicy.permissionModes!, inactiveLabel: 'Safe', activeLabel: 'YOLO' };
  },
  getModeSelector(): null {
    return null;
  },
  getProviderIcon() {
    return CODEBUDDY_PROVIDER_ICON;
  },
};
