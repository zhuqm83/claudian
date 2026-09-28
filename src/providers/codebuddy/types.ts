export interface CodeBuddyProviderState {
  nativeConversationContextEstablished?: boolean;
}

export function parseCodeBuddyProviderState(value: unknown): CodeBuddyProviderState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.nativeConversationContextEstablished === 'boolean'
      ? { nativeConversationContextEstablished: record.nativeConversationContextEstablished }
      : {}),
  };
}

export function buildPersistedCodeBuddyProviderState(
  state: CodeBuddyProviderState,
): CodeBuddyProviderState | undefined {
  const persisted = parseCodeBuddyProviderState(state);
  return Object.keys(persisted).length > 0 ? persisted : undefined;
}
