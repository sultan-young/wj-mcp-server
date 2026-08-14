export type WjCallData = {
  call_id?: string;
  model_id?: string;
  model_api_base?: string;
  duration_ms?: number;
};

export function extractWjCallData(body: unknown): WjCallData | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  return (
    readCallData(record.meta)
    ?? readCallData(nestedRecord(record.error)?.meta)
    ?? readCallData(nestedRecord(record.error)?.details)
    ?? readCallData(nestedRecord(record.data)?.meta)
  );
}

export function formatWjCallData(callData: WjCallData | undefined): string | undefined {
  if (!callData) return undefined;
  const parts: string[] = [];
  if (callData.call_id) parts.push(`call_id=${callData.call_id}`);
  if (callData.model_id) parts.push(`model_id=${callData.model_id}`);
  if (callData.model_api_base) parts.push(`model_api_base=${callData.model_api_base}`);
  if (!parts.length) return undefined;
  return parts.join("  ");
}

export function appendWjCallData(message: string, callData: WjCallData | undefined): string {
  const diagnostics = formatWjCallData(callData);
  return diagnostics ? `${message}\n${diagnostics}` : message;
}

function readCallData(value: unknown): WjCallData | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = "call_data" in value
    ? (value as { call_data?: unknown }).call_data
    : value;
  if (!source || typeof source !== "object") return undefined;
  const row = source as Record<string, unknown>;
  const callData: WjCallData = {};
  if (typeof row.call_id === "string" && row.call_id.trim()) callData.call_id = row.call_id.trim();
  if (typeof row.model_id === "string" && row.model_id.trim()) callData.model_id = row.model_id.trim();
  if (typeof row.model_api_base === "string" && row.model_api_base.trim()) {
    callData.model_api_base = row.model_api_base.trim();
  }
  if (typeof row.duration_ms === "number" && Number.isFinite(row.duration_ms) && row.duration_ms >= 0) {
    callData.duration_ms = Math.round(row.duration_ms);
  }
  return Object.keys(callData).length ? callData : undefined;
}

function nestedRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
