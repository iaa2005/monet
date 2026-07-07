/**
 * Provider Store — IPC-synced Zustand store for LLM providers.
 * All mutations go through main process (encrypted storage).
 */

import { create } from "zustand";

export type ProviderKind = "anthropic" | "deepseek" | "openai";

export interface LLMProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  baseURL: string;
  apiKey: string;
  model: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
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
}));
