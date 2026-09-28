import {
  buildSystemPrompt,
  type SystemPromptSettings,
} from '../../../core/prompt/mainAgent';

export type CodeBuddySystemPromptSettings = SystemPromptSettings;

export interface CodeBuddySystemPromptOptions {
  readonly dynamicSections?: readonly string[];
}

export function buildCodeBuddySystemPrompt(
  settings: CodeBuddySystemPromptSettings,
  options: CodeBuddySystemPromptOptions = {},
): string {
  return buildSystemPrompt(settings, {
    dynamicSections: options.dynamicSections ? [...options.dynamicSections] : undefined,
  });
}
