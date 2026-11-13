export type Rpc = (operation: string, payload?: Record<string, unknown>) => Promise<any>;

export class ApiError extends Error {
  constructor(public code: string, public status = 403) { super(code); }
}

export function remoteStore(url: string, publishableKey: string, serverKey: string): Rpc {
  return async (operation, payload = {}) => {
    let response: Response;
    try {
      response = await fetch(url + "/rest/v1/rpc/cq_dispatch", {
        method: "POST",
        headers: { apikey: publishableKey, "Content-Type": "application/json" },
        body: JSON.stringify({ secret: serverKey, operation, payload }),
        signal: AbortSignal.timeout(10000)
      });
    } catch { throw new ApiError("database_unavailable", 503); }
    if (!response.ok) throw new ApiError("database_unavailable", 503);
    const result = await response.json() as any;
    if (result.error) throw new ApiError(result.error, result.error === "rate_limited" || result.error === "quota_exceeded" ? 429 : 403);
    return result;
  };
}
