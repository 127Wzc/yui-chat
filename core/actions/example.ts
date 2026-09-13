/** 源码动作示例：只返回数据，由动作的回复设置提取并发送。 */
export function greet(args: Record<string, unknown>) {
  const prefix = String(args.prefix || "你好")
  const text = String(args.text || "世界")
  return { data: { text: `${prefix}，${text}！` } }
}
