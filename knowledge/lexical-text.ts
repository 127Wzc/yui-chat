const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" })

/** 入库和查询共用中文词语切分，补充双字片段并保留英文标识。 */
function tokenizeLexicalText(value: unknown): string[] {
  const source = String(value ?? "").toLowerCase()
  const terms: string[] = []
  for (const part of segmenter.segment(source)) {
    if (part.isWordLike) terms.push(part.segment)
  }
  for (const run of source.match(/[\p{Script=Han}]{2,}/gu) || []) {
    for (let index = 0; index < run.length - 1; index++) terms.push(run.slice(index, index + 2))
  }
  terms.push(...(source.match(/[a-z0-9_-]{2,}/gu) || []))
  return terms
}

export function lexicalTerms(value: unknown): string[] {
  return [...new Set(tokenizeLexicalText(value))]
}

export function lexicalIndexText(value: unknown): string {
  // BM25 依赖词频；只对查询去重，文档投影保留重复出现的词项。
  return tokenizeLexicalText(value).join(" ")
}
