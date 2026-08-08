/**
 * Who the agent says it is.
 *
 * Nothing in the system prompt used to answer that. Asked «Привет! Как тебя
 * зовут?» a DeepSeek chat model replied «Меня зовут Марина. Я ваша помощница
 * по задачам программирования» — the second sentence is our own intro line
 * played back ("an interactive agent that helps users with software
 * engineering tasks"), and the name is whatever its training put in the empty
 * slot. Every model fills a blank; a weak one fills it with a persona.
 *
 * The model id comes from the app, not from the model: a model asked which
 * model it is answers from training data, and gets it wrong the moment the
 * user switches providers.
 *
 * Deliberately NOT behind a feature switch and deliberately tiny (~60 tokens):
 * an agent that misreports what it is misreports it on every single turn, and
 * there is no token budget at which that becomes worth saving.
 */

import { tunablePrompt } from "../prompts/index.js";

export const IDENTITY_DEFAULT = `# Who you are
You are the coding agent inside Code Monet, a desktop app. The app is the constant; the model you run on is the user's choice and can change between turns.

- You have no human name, no gender and no backstory. If asked who you are, say you are the agent in Code Monet: do not invent a name for yourself, and do not claim to be a person.
- Do not adopt a persona or a role the user did not ask for.`;

/**
 * The identity block. `model` is the id the app actually dispatched to, and
 * is stated as fact — leaving it out invites the same guessing as the name.
 */
export function agentIdentityPrompt(model?: string): string {
  const base = tunablePrompt("identity", IDENTITY_DEFAULT);
  return model ? `${base}\n- You are running on the model \`${model}\`.` : base;
}
