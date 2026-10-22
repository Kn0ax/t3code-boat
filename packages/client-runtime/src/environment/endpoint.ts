import { boatProxySandboxId, BOAT_PROXY_TOKEN_QUERY_PARAM } from "@t3tools/shared/boatProxy";
export * from "@t3tools/shared/advertisedEndpoint";

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(httpBaseUrl);
  const proxy = boatProxySandboxId(httpBaseUrl) !== undefined;
  const token = proxy ? url.searchParams.get(BOAT_PROXY_TOKEN_QUERY_PARAM) : null;
  const endpoint = new URL(pathname, url.origin);
  url.pathname = proxy ? url.pathname + endpoint.pathname.replace(/^\//, "") : endpoint.pathname;
  url.search = endpoint.search;
  if (token !== null) url.searchParams.set(BOAT_PROXY_TOKEN_QUERY_PARAM, token);
  url.hash = "";
  return url.toString();
};
