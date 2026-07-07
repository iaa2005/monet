// Preload: defines MACRO global (build-time constant inlined by bun build)
(globalThis as any).MACRO = {
  VERSION: '1.0.0-leak',
  BUILD_TIME: new Date().toISOString(),
  PACKAGE_URL: '@anthropic-ai/claude-code',
  NATIVE_PACKAGE_URL: '@anthropic-ai/claude-code',
  FEEDBACK_CHANNEL: '#claude-code-feedback',
  ISSUES_EXPLAINER: 'report issues at https://github.com/anthropics/claude-code/issues',
  VERSION_CHANGELOG: '',
};
