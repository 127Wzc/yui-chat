import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
await fs.mkdir(path.join(root, 'cache'), { recursive: true })
const runtimeRoot = await fs.mkdtemp(path.join(root, 'cache', 'render-check-'))
process.env.YUI_CHAT_RUNTIME_ROOT = runtimeRoot
process.env.YUI_CHAT_PLUGIN_ROOT = root
const realBrowser = process.env.YUI_CHAT_RENDER_BROWSER_QA === '1'
const captures = []
let browser
let failBrowser = false
const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#fff8f8' } }).png().toBuffer()
const hooks = registerHooks({
  load(url, context, next) {
    if (url.endsWith('/lib/plugins/loader.js')) return { format: 'module', shortCircuit: true, source: 'export default { priority: [] }' }
    if (url.endsWith('/lib/renderer/loader.js')) return {
      format: 'module', shortCircuit: true,
      source: 'export default { getRenderer: () => ({ browserInit: async () => globalThis.__yuiRenderTestBrowser }) }',
    }
    return next(url, context)
  },
})
globalThis.__yuiRenderTestBrowser = {
  async newPage() {
    if (failBrowser) throw new Error('test browser unavailable')
    const page = realBrowser ? await browser.newPage() : null
    const capture = { html: '', closed: false, interception: false }
    captures.push(capture)
    return {
      async setRequestInterception(enabled) { capture.interception = enabled; await page?.setRequestInterception(enabled) },
      on(event, handler) { capture.handler = handler; page?.on(event, handler) },
      async setViewport(viewport) { capture.viewport = viewport; await page?.setViewport(viewport) },
      async goto(url, options) { capture.file = fileURLToPath(url); capture.html = await fs.readFile(capture.file, 'utf8'); await page?.goto(url, options) },
      async evaluate(fn, arg) { return page ? page.evaluate(fn, arg) : true },
      async screenshot(options) {
        if (!page) return png
        capture.dom = await page.evaluate(() => ({
          text: document.querySelector('#content')?.textContent,
          tag: document.querySelector('.window-tag')?.textContent,
          card: getComputedStyle(document.querySelector('.card')).borderRadius,
          katex: document.querySelectorAll('.katex').length,
          mermaid: document.querySelectorAll('.mermaid svg').length,
          headingColor: document.querySelector('#custom-heading') ? getComputedStyle(document.querySelector('#custom-heading')).color : '',
        }))
        const result = await page.screenshot(options)
        await fs.writeFile(path.join(root, 'cache', `render-qa-${captures.length}.png`), result)
        return result
      },
      async close() { capture.closed = true; await page?.close() },
    }
  },
}
try {
  if (realBrowser) {
    const { default: puppeteer } = await import('puppeteer')
    browser = await puppeteer.launch({ headless: true, userDataDir: path.join(runtimeRoot, 'browser'), args: ['--no-sandbox'] })
  }
  const { defaults } = await import('../output/runtime/config/defaults.js')
  const { resolveRenderRequest } = await import('../output/runtime/core/rendering/image-renderer-registry.js')
  const { renderImageByConfiguredEngine } = await import('../output/runtime/core/rendering/render-service.js')
  const { renderPreview } = await import('../output/runtime/core/rendering/render-api-service.js')
  const { toolRegistry } = await import('../output/runtime/tools/support/registry.js')
  const { createRenderTools } = await import('../output/runtime/tools/builtins/render.js')
  for (const tool of createRenderTools()) toolRegistry.register(tool)
  const { GenerateImageTool } = await import('../output/runtime/tools/builtins/image-generation.js')
  toolRegistry.register(new GenerateImageTool())
  const { ConfigStore } = await import('../output/runtime/config/store.js')
  const normalizedStore = new ConfigStore()
  await normalizedStore.attachRuntimeConfigRepository({
    load: async () => ({ exists: true, overrides: { response: { render: { html: { enabled: true }, url: { enabled: false } } } } }),
    save: async () => {},
  })
  const normalized = await normalizedStore.load()
  assert(!Object.hasOwn(normalized.response.render.html, 'enabled'), 'retired HTML gate is discarded')
  assert.equal(normalized.response.render.url.enabled, false, 'retired HTML gate must not enable URL screenshots')
  const config = structuredClone(defaults)
  config.tools.enabled = true
  config.response.render.html.waitMs = 0
  config.response.render.html.waitUntil = 'load'
  const master = { config, e: { isMaster: true, user_id: '10001' } }
  const call = (args, context = master) => toolRegistry.execute('render_image', { ...args, send: false }, context)
  const { selectPromptTools } = await import('../output/runtime/core/chat/token-budget.js')
  for (const [query, expected] of [
    ['画图', 'generate_image'], ['用画图工具画一个白发角色', 'generate_image'],
    ['修改参考图片', 'generate_image'], ['draw an illustration', 'generate_image'],
    ['Markdown 数学公式排版', 'render_image'], ['HTML 表格转图片', 'render_image'],
    ['生成 Markdown 表格图片', 'render_image'],
  ]) {
    const matches = await toolRegistry.searchAllowedTools(query, master, 2)
    assert.equal(selectPromptTools(await toolRegistry.getAllowedTools(master), query, { enabled: true, maxTools: 1, maxDefinitionTokens: 4000 })[0]?.name, expected, `first-round selection: ${query}`)
    assert.equal(matches[0]?.name, expected, `tool discovery: ${query}; ${JSON.stringify(matches.map(item => ({name:item.name,score:item.score})))}`)
  }
  const { responsesToolDefinition, modelToolDefinition } = await import('../output/runtime/tools/support/contract.js')
  for (const define of [responsesToolDefinition, modelToolDefinition]) {
    const drawing = define(toolRegistry.get('generate_image'))
    const render = define(toolRegistry.get('render_image'))
    assert.match((drawing.function || drawing).description, /actual visual images/)
    assert.match((render.function || render).description, /NOT AI drawing/)
  }

  assert.equal(resolveRenderRequest({ data: { content: '<div>Hi</div>' } }).kind, 'html')
  assert.equal(resolveRenderRequest({ data: { content: '<span>Hi</span>' } }).kind, 'html')
  assert.equal(resolveRenderRequest({ data: { content: '# Markdown\n$ x^2 $' } }).kind, 'markdown')
  assert.equal(resolveRenderRequest({ data: { content: '```html\n<div>example</div>\n```' } }).kind, 'markdown')
  assert.equal(resolveRenderRequest({ format: 'markdown', data: { content: '<div>example</div>' } }).kind, 'markdown')
  assert.equal(resolveRenderRequest({ data: { sections: [{ lines: ['hi'] }] } }).kind, 'text-card')
  assert.throws(() => resolveRenderRequest({ template: 'html', data: { html: '<div>legacy</div>' } }), /format/)
  assert.throws(() => resolveRenderRequest({ format: 'math', data: { content: 'x^2' } }), /支持的格式/)
  assert(!toolRegistry.get('render_html_screenshot'), 'no separate HTML tool or permission')
  const htmlArgs = { format: 'html', data: { title: '<Title>', content: '<h1>HTML 正常</h1><p>统一样式</p>' } }
  const disabledTool = structuredClone(config)
  disabledTool.tools.enabledTools = disabledTool.tools.enabledTools.filter(name => name !== 'render_image')
  await assert.rejects(() => call(htmlArgs, { ...master, config: disabledTool }), /未启用/)
  const disabledRender = structuredClone(config)
  disabledRender.response.render.enabled = false
  await assert.rejects(() => call(htmlArgs, { ...master, config: disabledRender }), /未启用/)
  await assert.rejects(() => renderPreview({ format: 'html', data: htmlArgs.data }, disabledRender), /未启用/)
  await assert.rejects(() => call({ format: 'html', data: { content: '' } }), /不能为空|必填/)
  await assert.rejects(() => call({ format: 'html', data: { content: 'x'.repeat(200001) } }), /超过/)
  await assert.rejects(() => call({ format: 'unknown' }), /参数无效|支持/)
  assert.equal(captures.length, 0, 'rejected inputs must not open a browser page')
  assert.match(await call(htmlArgs, { ...master, e: { user_id: '10002' } }), /HTML渲染完成/)
  assert(captures.at(-1).html.includes('&lt;Title&gt;'))
  assert(captures.at(-1).html.includes('<h1>HTML 正常</h1>'))
  const fullDocument = '<!doctype html><html><head><style>#custom-heading{color:rgb(0,128,0)}</style></head><body><h1 id="custom-heading">完整文档</h1></body></html>'
  const preview = await renderPreview({ format: 'html', data: { content: fullDocument } }, config)
  assert.equal(preview.engine, 'html')
  assert.equal(preview.fallback, false)
  assert.equal(Buffer.from(preview.imageBase64, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  if (realBrowser) {
    assert.equal(captures.at(-1).dom.headingColor, 'rgb(0, 128, 0)')
    assert.equal(captures.at(-1).dom.card, '40px')
    assert.match(captures.at(-1).dom.text, /完整文档/)
  }
  await call({ format: 'markdown', data: { content: '# 数学与图表\n\n$$a^2+b^2=c^2$$\n\n```mermaid\nflowchart LR\nA --> B\n```' } })
  if (realBrowser) {
    assert.equal(captures.at(-1).dom.tag, 'Markdown')
    assert(captures.at(-1).dom.katex > 0)
    assert(captures.at(-1).dom.mermaid > 0)
  }
  await call({ format: 'markdown', data: { content: '$$\\frac{1}{2}$$' } })
  if (realBrowser) assert(captures.at(-1).dom.katex > 0)
  await call({ format: 'mindmap', data: { content: '# 根节点\n## 子节点' } })
  await call({ format: 'text', data: { title: '文本', content: '保留卡片' } }, { ...master, config: { ...config, response: { ...config.response, render: { ...config.response.render, engine: 'svg' } } } })
  for (const capture of captures) {
    assert(capture.closed && capture.interception)
    await assert.rejects(() => fs.access(capture.file), /ENOENT/)
  }
  const svgConfig = structuredClone(config)
  svgConfig.response.render.engine = 'svg'
  failBrowser = true
  await assert.rejects(() => renderImageByConfiguredEngine('html', { html: htmlArgs.data.content }, svgConfig), /test browser unavailable/)
  console.log(`Render checks passed${realBrowser ? ' (real Chromium, HTML/CSS + KaTeX + Mermaid)' : ''}.`)
} finally {
  await browser?.close()
  hooks.deregister()
  delete globalThis.__yuiRenderTestBrowser
  await fs.rm(runtimeRoot, { recursive: true, force: true })
}

process.exit(0)
