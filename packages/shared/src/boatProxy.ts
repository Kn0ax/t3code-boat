export const BOAT_PROXY_PATH_PREFIX = "/api/boat-proxy/";
export const BOAT_PROXY_TOKEN_QUERY_PARAM = "boatProxyToken";

export const boatProxySandboxId = (value: string): string | undefined => {
  const path = new URL(value).pathname;
  return /^\/api\/boat-proxy\/([a-zA-Z0-9_-]+)\/$/.exec(path)?.[1];
};

export const boatProxyBaseUrl = (hostBaseUrl: string, sandboxId: string): string => {
  if (!/^[a-zA-Z0-9_-]+$/.test(sandboxId)) {
    throw new Error("Invalid Boat sandbox ID.");
  }
  const url = new URL(hostBaseUrl);
  url.pathname = BOAT_PROXY_PATH_PREFIX + sandboxId + "/";
  url.search = "";
  url.hash = "";
  return url.toString();
};

export const withBoatProxyToken = (baseUrl: string, token: string): string => {
  if (boatProxySandboxId(baseUrl) === undefined) {
    throw new Error("Invalid Boat proxy base URL.");
  }
  const url = new URL(baseUrl);
  url.searchParams.set(BOAT_PROXY_TOKEN_QUERY_PARAM, token);
  return url.toString();
};
