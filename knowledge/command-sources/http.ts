import { fetchSafeHttp } from "../../core/network/safe-http-client.js"
export async function commandApi(address: string, pathname: string, token: string) {
  const base = new URL(address)
  if (base.username || base.password || !["http:", "https:"].includes(base.protocol)) throw new Error("无效 API 地址")
  const local = ["127.0.0.1", "[::1]"].includes(base.hostname)
  if (!local && base.protocol !== "https:") throw new Error("远程 API 必须使用 HTTPS")
  const response = await fetchSafeHttp(new URL(pathname, base).href, {headers:{Authorization:"Bearer "+token.trim()},allowPrivateHosts:local,maxRedirects:0,timeoutMs:15000,maxBytes:12*1024*1024})
  if (!response.ok) throw new Error("采集 API HTTP "+response.status)
  return response.json()
}
