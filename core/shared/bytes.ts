/**
 * 将 Buffer、TypedArray 或普通的数字数组转换为可交给 Node 二进制 API 的字节视图。
 *
 * Buffer 的类型会随 @types/node 与 TypeScript 的 ArrayBuffer 泛型变化，直接把
 * Buffer 传给 fs/crypto 容易在不同构建环境产生类型冲突。这里优先复用原有内存
 * 视图；遇到只有 length 的 ArrayLike 时才复制一份。
 */
export type ByteView = ArrayLike<number> & {
  buffer?: ArrayBufferLike
  byteOffset?: number
  byteLength?: number
}

export function toByteView(value: ByteView): Uint8Array {
  if (value.buffer !== undefined && value.byteOffset !== undefined && value.byteLength !== undefined) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  return Uint8Array.from(value)
}
