// Shim for missing connectorText type (not in leaked sourcemap)
export type ConnectorTextBlock = {
  type: 'connector_text';
  text: string;
};
export function isConnectorTextBlock(value: unknown): value is ConnectorTextBlock {
  return typeof value === 'object' && value !== null && (value as any).type === 'connector_text';
}

export type ConnectorTextDelta = {
  type: 'connector_text_delta';
  text: string;
};
