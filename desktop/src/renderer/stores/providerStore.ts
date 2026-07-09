/**
 * Provider Store — IPC-synced Zustand store for LLM providers.
 * All mutations go through main process (encrypted storage).
 */

import { create } from "zustand";

export type ProviderKind = "anthropic" | "deepseek" | "openai" | "openrouter";

/** What a model accepts as input. */
export type Modality = "text" | "image" | "audio" | "file" | "video";

export interface ProviderModel {
  id: string;
  /** Model id sent to the API. */
  name: string;
  /** Display label (falls back to name). */
  label?: string;
  /** Per-model Base URL override. */
  baseURL?: string;
  contextLength?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  temperature?: number;
  /** Input modalities the model accepts (defaults to text-only). */
  modalities?: Modality[];
  /** Hidden models don't show in the composer's model picker. */
  hidden?: boolean;
}

export interface LLMProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  baseURL: string;
  apiKey: string;
  isActive: boolean;
  models: ProviderModel[];
  activeModelId?: string;
  // Legacy single-model view (main resolves the active model into these).
  model: string;
  maxTokens: number;
  temperature?: number;
  contextLimit: number;
  createdAt: string;
  updatedAt: string;
}

/** The provider's in-use model (activeModelId, falling back to the first). */
export function activeModelOf(p: LLMProvider): ProviderModel | undefined {
  return p.models?.find((m) => m.id === p.activeModelId) ?? p.models?.[0];
}

export type LLMProviderInput = Omit<
  LLMProvider,
  "id" | "createdAt" | "updatedAt"
>;

interface ProviderStore {
  providers: LLMProvider[];
  loading: boolean;
  error: string | null;

  load: () => Promise<void>;
  add: (input: LLMProviderInput) => Promise<void>;
  update: (id: string, input: Partial<LLMProviderInput>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setActive: (id: string) => Promise<void>;
  setActiveModel: (providerId: string, modelId: string) => Promise<void>;
}

function api() {
  return window.electronAPI.providers;
}

export const useProviderStore = create<ProviderStore>((set) => ({
  providers: [],
  loading: true,
  error: null,

  load: async () => {
    try {
      set({ loading: true, error: null });
      const providers = await api().list();
      set({ providers: providers as LLMProvider[], loading: false });
    } catch (err) {
      set({ error: String(err), loading: false });
    }
  },

  add: async (input) => {
    try {
      await api().add(input as never);
      const providers = await api().list();
      set({ providers: providers as LLMProvider[] });
    } catch (err) {
      set({ error: String(err) });
    }
  },

  update: async (id, input) => {
    try {
      await api().update(id, input as never);
      const providers = await api().list();
      set({ providers: providers as LLMProvider[] });
    } catch (err) {
      set({ error: String(err) });
    }
  },

  remove: async (id) => {
    try {
      await api().remove(id);
      const providers = await api().list();
      set({ providers: providers as LLMProvider[] });
    } catch (err) {
      set({ error: String(err) });
    }
  },

  setActive: async (id) => {
    try {
      await api().setActive(id);
      const providers = await api().list();
      set({ providers: providers as LLMProvider[] });
    } catch (err) {
      set({ error: String(err) });
    }
  },

  setActiveModel: async (providerId, modelId) => {
    try {
      await api().setActiveModel(providerId, modelId);
      const providers = await api().list();
      set({ providers: providers as LLMProvider[] });
    } catch (err) {
      set({ error: String(err) });
    }
  },
}));
