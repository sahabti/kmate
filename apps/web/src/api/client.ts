import { createClient, Code, ConnectError, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { HubService } from "@/gen/kmate/v1/hub_pb";
import { ClusterService } from "@/gen/kmate/v1/cluster_pb";
import { useSession } from "@/store/session";
import { platform } from "@/platform";

const authInterceptor: Interceptor = (next) => async (req) => {
  const token = useSession.getState().token;
  if (token) req.header.set("Authorization", `Bearer ${token}`);
  try {
    return await next(req);
  } catch (e) {
    if (e instanceof ConnectError && e.code === Code.Unauthenticated) {
      useSession.getState().clear();
      if (!window.location.pathname.startsWith("/login")) {
        window.location.assign("/login");
      }
    }
    throw e;
  }
};

export const transport = createConnectTransport({
  baseUrl: platform.hubUrl(),
  useBinaryFormat: false, // JSON keeps things curl-able and debuggable
  interceptors: [authInterceptor],
});

export const hub = createClient(HubService, transport);
export const cluster = createClient(ClusterService, transport);

export function errorMessage(e: unknown): string {
  if (e instanceof ConnectError) return e.rawMessage || e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Hub WebSocket URL for exec / port-forward. Array values repeat the key (e.g. cmd=a&cmd=b). */
export function wsUrl(path: string, params: Record<string, string | string[]>): string {
  const base = platform.hubUrl().replace(/^http/, "ws");
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => q.append(k, x));
    else q.set(k, v);
  }
  const token = useSession.getState().token;
  if (token) q.set("token", token);
  return `${base}${path}?${q.toString()}`;
}

/**
 * Port-forward through the hub's HTTP proxy. `POST /pf/session` exchanges the
 * bearer token for a cookie (browsers can't set headers on a new tab), then the
 * proxied app is opened at /pf/{cluster}/{ns}/{pod}/{port}/.
 */
export async function openPortForward(clusterId: string, namespace: string, pod: string, port: number): Promise<string> {
  const token = useSession.getState().token;
  const res = await fetch(`${platform.hubUrl()}/pf/session`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: "include",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`port-forward session failed: ${res.status} ${text || res.statusText}`.trim());
  }
  const url = `${platform.hubUrl()}/pf/${encodeURIComponent(clusterId)}/${encodeURIComponent(namespace)}/${encodeURIComponent(pod)}/${port}/`;
  platform.openExternal(url);
  return url;
}
