/** 未配置/null 保持全部开放；空数组关闭全部，名单使用服务原始工具名。 */
export function isMcpToolSelected(server: Record<string, unknown>, name: string): boolean {
  return server.allowedTools === undefined || server.allowedTools === null
    || (Array.isArray(server.allowedTools) && server.allowedTools.includes(name))
}
