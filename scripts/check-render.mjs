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
      source: 'export default { getRenderer: () => globalThis.__yuiRenderTestRenderer }',
    }
    return next(url, context)
  },
})
globalThis.__yuiRenderTestBrowser = {
  isConnected() { return realBrowser ? browser.isConnected() : true },
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
      frames() { return page?.frames() || [] },
      async evaluate(fn, arg) { return page ? page.evaluate(fn, arg) : undefined },
      async screenshot(options) {
        if (!page) return png
        const contentFrame = page.frames().find(frame => frame.name() === 'yui-html-content')
        const contentDom = contentFrame ? await contentFrame.evaluate(() => ({
          text: document.body.textContent,
          headingColor: document.querySelector('#custom-heading') ? getComputedStyle(document.querySelector('#custom-heading')).color : '',
          scene: document.querySelector('.scene')?.getBoundingClientRect().toJSON(),
        })) : null
        capture.options = options
        capture.dom = await page.evaluate(() => ({
          text: document.querySelector('#content')?.textContent,
          tag: document.querySelector('.window-tag')?.textContent,
          card: getComputedStyle(document.querySelector('.card')).borderRadius,
          cardBackground: getComputedStyle(document.querySelector('.card')).backgroundImage,
          dots: [...document.querySelectorAll('.window-buttons span')].map(dot => ({ width: dot.getBoundingClientRect().width, color: getComputedStyle(dot).backgroundColor })),
          katex: document.querySelectorAll('.katex').length,
          mermaid: document.querySelectorAll('.mermaid svg').length,
          headingColor: document.querySelector('#custom-heading') ? getComputedStyle(document.querySelector('#custom-heading')).color : '',
        }))
        if (contentDom) Object.assign(capture.dom, contentDom)
        capture.layout = await page.evaluate(() => {
          const frame = document.querySelector('#html-content-frame')
          return { frame: frame?.getBoundingClientRect().toJSON(), card: document.querySelector('#render-card')?.getBoundingClientRect().toJSON(), footer: document.querySelector('footer')?.getBoundingClientRect().toJSON() }
        })
        const result = await page.screenshot(options)
        capture.image = await sharp(result).metadata()
        await fs.writeFile(path.join(root, 'cache', `render-qa-${captures.length}.png`), result)
        return result
      },
      async close() { capture.closed = true; await page?.close() },
    }
  },
}
globalThis.__yuiRenderTestRenderer = {
  browserInit: async () => globalThis.__yuiRenderTestBrowser,
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
  config.tools.boundaryAccess.roles.user.allowedTools = ['render_image']
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
  assert(captures.at(-1).html.includes('&lt;h1&gt;HTML 正常&lt;/h1&gt;'))
  const fullDocument = '<!doctype html><html><head><style>#custom-heading{color:rgb(0,128,0)}</style></head><body><h1 id="custom-heading">完整文档</h1></body></html>'
  const preview = await renderPreview({ format: 'html', data: { content: fullDocument } }, config)
  assert.equal(preview.engine, 'html')
  assert.equal(preview.fallback, false)
  assert.equal(Buffer.from(preview.imageBase64, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  if (realBrowser) {
    assert.equal(captures.at(-1).dom.headingColor, 'rgb(0, 128, 0)')
    assert.equal(captures.at(-1).dom.card, '18px')
    assert.equal(captures.at(-1).dom.dots.length, 3, 'window controls remain even without a custom title')
    assert(captures.at(-1).dom.dots.every(dot => dot.width === 10))
    assert.match(captures.at(-1).dom.cardBackground, /rgb\(255, 240, 243\)/)
    assert.match(captures.at(-1).dom.text, /完整文档/)
  }
  const tool = createRenderTools().find(tool => tool.name === 'render_image')
  assert(!tool.parameters.properties.data.properties.viewport)
  assert(!tool.parameters.properties.data.properties.fullPage)
  assert.match(tool.parameters.properties.send.description, /Defaults to true/)
  const croppedInput = { content: '<html><head><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:cyan} .card{border-radius:0!important} footer{display:none} .scene{width:1500px;height:920px;background:green}</style></head><body><div class="scene">完整场景</div></body></html>', viewport: { width: 900, height: 620 }, fullPage: false }
  await call({ format: 'html', data: croppedInput })
  if (realBrowser) {
    const capture = captures.at(-1)
    assert.equal(capture.dom.card, '18px', 'content CSS cannot change outer card')
    assert(capture.options.clip)
    assert(capture.layout.frame.width >= 1500)
    assert(capture.layout.frame.height >= 920)
    assert(capture.layout.footer.height > 0, 'content CSS cannot hide outer footer')
    assert(capture.image.width >= capture.layout.card.right + 9)
    assert(capture.image.height >= capture.layout.card.bottom + 9)
  }
  await call({ format: 'html', data: { title: '新闻', subtitle: '更新于 00:15', content: '<div style="width:900px;height:620px;margin:auto;background:skyblue">主体</div>' } })
  if (realBrowser) {
    const capture = captures.at(-1)
    assert(capture.image.width < 960, 'fixed canvas should not retain 1200px outer width')
    assert(capture.image.height < 750, 'compact header and footer should not force 800px minimum height')
    assert(capture.layout.frame.width >= 900)
    assert(capture.layout.footer.top >= capture.layout.frame.bottom)
  }
  await call({ format: 'markdown', data: { content: '# 数学与图表\n\n$$a^2+b^2=c^2$$\n\n```mermaid\nflowchart LR\nA --> B\n```' } })
  if (realBrowser) {
    assert.match(captures.at(-1).html, /Yui Chat/)
    assert(captures.at(-1).dom.katex > 0)
    assert(captures.at(-1).dom.mermaid > 0)
  }
  await call({ format: 'markdown', data: { content: '$$\\frac{1}{2}$$' } })
  if (realBrowser) assert(captures.at(-1).dom.katex > 0)
  await call({ format: 'mindmap', data: { content: '# 根节点\n## 子节点' } })
  await call({ format: 'text', data: { title: '文本', content: '保留卡片' } }, { ...master, config: { ...config, response: { ...config.response, render: { ...config.response.render, engine: 'svg' } } } })
  await checkAutomaticReplyRendering(config)
  for (const capture of captures) {
    assert(capture.closed && capture.interception)
    await assert.rejects(() => fs.access(capture.file), /ENOENT/)
  }
  const svgConfig = structuredClone(config)
  svgConfig.response.render.engine = 'svg'
  failBrowser = true
  await assert.rejects(() => renderImageByConfiguredEngine('html', { html: htmlArgs.data.content }, svgConfig), /test browser unavailable/)
  await checkBrowserRecovery(renderImageByConfiguredEngine, config)
  console.log(`Render checks passed${realBrowser ? ' (real Chromium, HTML/CSS + KaTeX + Mermaid)' : ''}.`)
} finally {
  await browser?.close()
  hooks.deregister()
  delete globalThis.__yuiRenderTestBrowser
  delete globalThis.__yuiRenderTestRenderer
  await fs.rm(runtimeRoot, { recursive: true, force: true })
}

process.exit(0)

async function checkAutomaticReplyRendering(config) {
  const { buildReplyPayload } = await import('../output/runtime/core/chat/response-pipeline.js')
  const { sendChatOutput } = await import('../output/runtime/core/chat/output-service.js')
  const { userSettingsStore } = await import('../output/runtime/user/settings.js')
  const answer = '# 回复标题\n\n**回复重点**与[链接](https://example.com/answer)\n\n$ x^2 $'
  const e = {
    isGroup: true, user_id: 'private-user-id', group_id: 'private-group-id',
    group_name: 'private-group-name', sender: { nickname: 'private-user-name' },
  }
  const result = {
    text: answer, channel: 'private-model-channel', adapter: 'private-model-adapter',
    prompt: 'private-user-prompt', toolRounds: 2,
    steps: [{ stepId: 'private-model-step', channel: 'private-step-channel', status: 'ok' }],
    media: { diagnostics: ['private-media-diagnostic'], quote: { text: 'private-quoted-text' } },
  }
  const privateValues = [e.user_id, e.group_id, e.group_name, e.sender.nickname, result.channel, result.adapter,
    result.prompt, result.steps[0].stepId, result.steps[0].channel, result.media.diagnostics[0], result.media.quote.text]
  const checkContent = () => {
    const capture = captures.at(-1)
    const data = capture.html.match(/<script type="application\/json" id="markdown-data">([\s\S]*?)<\/script>/)?.[1]
    assert.equal(JSON.parse(data), answer, 'automatic images render only the final reply as Markdown')
    for (const value of privateValues) assert(!capture.html.includes(value), `automatic reply image leaks ${value}`)
    if (realBrowser) {
      assert.match(capture.dom.text, /回复标题/)
      assert(!capture.dom.text.includes('**回复重点**'), 'automatic images parse Markdown emphasis')
      assert(capture.dom.katex > 0, 'automatic images render Markdown formulas')
    }
  }
  const forced = await buildReplyPayload(answer, config, { forceImage: true, e, result })
  assert(forced.asImage && Buffer.isBuffer(forced.image), 'picture mode uses the reply renderer')
  checkContent()
  const automaticConfig = structuredClone(config)
  automaticConfig.response.autoUsePicture = true
  automaticConfig.response.autoUsePictureThreshold = answer.length
  const automatic = await buildReplyPayload(answer, automaticConfig, { e, result })
  assert(automatic.asImage, 'long replies use the same Markdown renderer')
  checkContent()
  const sent = []
  const deliveryEvent = { ...e, reply: async payload => { sent.push(payload); return true } }
  await userSettingsStore.set(e, { mode: 'picture' })
  const deliveryConfig = structuredClone(config)
  deliveryConfig.response.messageFilters.enabled = false
  for (const source of ['', 'firstPerson']) {
    await sendChatOutput(deliveryEvent, result, deliveryConfig, { source, armContinuation: false })
    checkContent()
  }
  assert.equal(sent.length, 2, 'ordinary and first-person picture replies each send once')
  const before = captures.length
  const disabledConfig = structuredClone(config)
  disabledConfig.response.render.enabled = false
  assert.equal((await buildReplyPayload(answer, disabledConfig, { forceImage: true })).asImage, false)
  assert.equal((await buildReplyPayload('<EMPTY>', config, { forceImage: true })).empty, true)
  assert.equal((await buildReplyPayload('[CQ:at,qq=123456] 提醒', config, { forceImage: true })).asImage, false)
  const svgConfig = structuredClone(config)
  svgConfig.response.render.system.engine = 'svg'
  const svg = await buildReplyPayload(answer, svgConfig, { forceImage: true, e, result })
  assert.equal(svg.image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'system SVG strategy still renders a PNG')
  assert.equal(captures.length, before, 'disabled, empty, mention and system SVG replies do not open a browser')
  failBrowser = true
  try {
    const fallback = await buildReplyPayload(answer, config, { forceImage: true, e, result })
    assert.equal(fallback.image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'automatic replies retain HTML-to-SVG fallback')
  } finally {
    failBrowser = false
  }
}

async function checkBrowserRecovery(render, config) {
  const previousLogger = globalThis.logger
  const logs = []
  globalThis.logger = Object.fromEntries(['info', 'warn', 'debug'].map(level => [level, (...args) => logs.push({ level, args })]))
  const host = globalThis.__yuiRenderTestRenderer
  let initCalls = 0
  let restartCalls = 0
  let replacement
  host.browserInit = async () => { initCalls++; return host.browser }
  host.restart = async force => {
    assert.equal(force, true)
    restartCalls++
    host.lock = true
    host.browser = false
    await new Promise(resolve => setTimeout(resolve, 20))
    host.browser = replacement
    host.lock = false
    return replacement
  }
  const pages = []
  const makeBrowser = (options = {}) => {
    const instance = {
      connected: options.connected ?? true,
      pageCalls: 0,
      isConnected() { return this.connected },
      process() { return { pid: 1234, exitCode: this.connected ? null : 1, signalCode: null } },
      once(event, listener) { assert.equal(event, 'disconnected'); this.onDisconnected = listener },
      async newPage() {
        this.pageCalls++
        if (options.newPage) return options.newPage(instance)
        const page = { closed: false, loads: 0, interception: false, handlers: {},
          async setRequestInterception(enabled) { this.interception = enabled },
          on(event, listener) { this.handlers[event] = listener },
          async setViewport() {},
          async goto(url) {
            assert(this.interception, 'requests must be guarded before navigation, including after recovery')
            this.loads++
            if (options.goto) return options.goto(instance, page, url)
          },
          async evaluate() {},
          async screenshot() { if (options.screenshot) return options.screenshot(instance, page); return png },
          async close() { this.closed = true },
        }
        pages.push(page)
        return page
      },
    }
    return instance
  }
  const closedError = () => Object.assign(new Error('Connection closed.'), { name: 'ConnectionClosedError' })
  const run = (cfg = config) => render('markdown', { content: '# 恢复测试' }, cfg)
  try {
    host.browser = makeBrowser()
    assert.equal((await run()).meta.fallback, false)
    const original = host.browser
    host.browser = makeBrowser()
    assert.equal((await run()).meta.fallback, false)
    assert.equal(original.pageCalls, 1, 'do not keep the old browser after the host replaces it')
    assert.equal(host.browser.pageCalls, 1)
    assert.equal(initCalls, 2, 'every render acquires the current host browser')

    host.browser = makeBrowser({ connected: false })
    replacement = makeBrowser()
    assert.equal((await run()).meta.fallback, false)
    assert.equal(restartCalls, 1, 'a disconnected instance still held by the host requests host recovery')

    const broken = makeBrowser({ newPage: async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      throw closedError()
    } })
    host.browser = broken
    replacement = makeBrowser()
    const parallel = await Promise.all(Array.from({ length: 8 }, () => run()))
    assert(parallel.every(result => !result.meta.fallback))
    assert.equal(restartCalls, 2, 'concurrent ConnectionClosedError failures share one host restart')
    assert.equal(broken.pageCalls, 8)
    assert.equal(replacement.pageCalls, 8, 'each render retries page creation only once')

    replacement = makeBrowser()
    host.browser = makeBrowser({ newPage: async () => { host.browser = replacement; throw closedError() } })
    assert.equal((await run()).meta.fallback, false)
    assert.equal(restartCalls, 2, 'do not restart an already replaced host browser')

    host.lock = true
    host.browser = false
    setTimeout(() => { host.browser = makeBrowser(); host.lock = false }, 20)
    assert.equal((await run()).meta.fallback, false, 'wait for old host initialization locks instead of treating false as permanent failure')

    host.browser = makeBrowser({ newPage: async () => { throw closedError() } })
    replacement = makeBrowser({ newPage: async () => { throw closedError() } })
    assert.equal((await run()).meta.fallback, true, 'a second connection failure falls back without looping')
    assert.equal(restartCalls, 3)
    assert.equal(replacement.pageCalls, 1)
    host.browser = makeBrowser()
    assert.equal((await run()).meta.fallback, false, 'fallback must not poison future HTML renders')

    host.browser = makeBrowser({ goto: async instance => { instance.connected = false; throw closedError() } })
    replacement = makeBrowser()
    assert.equal((await run()).meta.fallback, true, 'do not replay a page after navigation starts')
    assert.equal(pages.at(-1).loads, 1)
    assert.equal(replacement.pageCalls, 0, 'mid-render recovery is only for subsequent requests')
    assert.equal((await run()).meta.fallback, false)
    assert.equal(restartCalls, 4)

    host.browser = makeBrowser({ goto: async () => { throw new Error('Navigation timeout Authorization: Bearer secret-value https://user:pass@example.com/?token=hidden') } })
    assert.equal((await run()).meta.fallback, true)
    assert.equal(host.browser.pageCalls, 1)
    assert.equal(restartCalls, 4, 'ordinary content/loading failures must not restart the shared browser')
    const diagnostic = logs.find(log => log.args[1]?.stage === 'page-load' && log.args[1]?.error?.includes('Navigation timeout'))
    assert(diagnostic)
    assert.equal(diagnostic.args[1].pid, 1234)
    assert(diagnostic.args[1].renderId && diagnostic.args[1].browserId)
    assert(!JSON.stringify(logs).includes('secret-value'))
    assert(!JSON.stringify(logs).includes('hidden'))
    assert(!JSON.stringify(logs).includes('user:pass'))

    const { renderUrlToPng } = await import('../output/runtime/core/rendering/render-html-service.js')
    const urlConfig = structuredClone(config)
    urlConfig.response.render.url.enabled = true
    urlConfig.security.linkSafety.screenshotAllowedHosts = ['example.com']
    host.browser = makeBrowser({ newPage: async () => { throw closedError() } })
    replacement = makeBrowser()
    await renderUrlToPng('https://example.com/', { waitMs: 0 }, urlConfig)
    const urlPage = pages.at(-1)
    let blocked = false
    await urlPage.handlers.request({ url: () => 'https://not-allowed.example.org/', continue() { assert.fail('disallowed host must not load') }, abort(reason) { blocked = reason === 'blockedbyclient' } })
    assert(blocked, 'URL host restrictions still apply to recovered pages')
    assert.equal(restartCalls, 5)
    host.browser = makeBrowser({ goto: async instance => { instance.connected = false; throw closedError() } })
    replacement = makeBrowser()
    await assert.rejects(() => renderUrlToPng('https://example.com/', { waitMs: 0 }, urlConfig), /stage=page-load/)
    assert.equal(replacement.pageCalls, 0, 'URL navigation is never replayed automatically')
    assert.equal(restartCalls, 6)

    const shortConfig = structuredClone(config)
    shortConfig.response.render.html.timeoutMs = 100
    const ready = makeBrowser()
    host.browserInit = async () => { await new Promise(resolve => setTimeout(resolve, 200)); return ready }
    assert.equal((await run(shortConfig)).meta.fallback, true, 'hung initialization has a bounded wait')
    await new Promise(resolve => setTimeout(resolve, 150))
    host.browserInit = async () => host.browser
    host.browser = ready
    assert.equal((await run()).meta.fallback, false, 'late initialization does not poison the next render')

    let lateClosed = false
    host.browser = makeBrowser({ newPage: async () => {
      await new Promise(resolve => setTimeout(resolve, 200))
      return { async close() { lateClosed = true } }
    } })
    assert.equal((await run(shortConfig)).meta.fallback, true)
    await new Promise(resolve => setTimeout(resolve, 150))
    assert(lateClosed, 'pages arriving after the creation timeout are closed')
    assert.equal(restartCalls, 6, 'a slow page creation must not restart a connected shared browser')

    let pendingInits = 0
    host.browser = false
    host.browserInitPromise = true
    host.browserInit = async () => {
      pendingInits++
      await new Promise(resolve => setTimeout(resolve, 20))
      host.browserInitPromise = null
      return host.browser = makeBrowser()
    }
    const waiting = await Promise.all(Array.from({ length: 4 }, () => run()))
    assert(waiting.every(result => !result.meta.fallback))
    assert.equal(pendingInits, 1, 'new host initialization promises are shared by concurrent renders')
    host.browserInit = async () => host.browser

    const restart = host.restart
    const failed = makeBrowser({ connected: false })
    host.browser = failed
    host.restart = async () => { throw new Error('test host restart failed') }
    assert.equal((await run()).meta.fallback, true, 'host recovery failures keep SVG fallback')
    assert(logs.some(log => log.args[0].includes('恢复失败') && log.args[1]?.error?.includes('test host restart failed')))
    host.restart = restart
    replacement = makeBrowser()
    assert.equal((await run()).meta.fallback, false, 'a rejected recovery is removed so the same failed instance can recover next time')
    assert.equal(restartCalls, 7)

    host.browser = makeBrowser({ connected: false })
    delete host.restart
    assert.equal((await run()).meta.fallback, true, 'a host without a restart method is not mutated by the plugin')
    host.browser = makeBrowser()
    assert.equal((await run()).meta.fallback, false)
    host.restart = restart

    host.browser = makeBrowser({ screenshot: async instance => { instance.connected = false; throw closedError() } })
    replacement = makeBrowser()
    assert.equal((await run()).meta.fallback, true)
    assert.equal(pages.at(-1).loads, 1)
    assert.equal(replacement.pageCalls, 0)
    assert(logs.some(log => log.args[0].includes('浏览器渲染失败') && log.args[1]?.stage === 'screenshot'))
    assert.equal((await run()).meta.fallback, false)
    const listener = host.browser.onDisconnected
    assert(listener)
    host.browser.connected = false
    listener()
    assert(logs.some(log => log.args[0].includes('连接断开') && log.args[1]?.exitCode === 1))

    assert(pages.every(page => page.closed), 'all successful and failed pages are cleaned up')
    assert(logs.some(log => log.args[0].includes('恢复成功')))
    const htmlFiles = await fs.readdir(path.join(runtimeRoot, 'cache/temp/render-html'))
    assert.equal(htmlFiles.length, 0, 'recovery and fallback leave no temporary HTML files')
  } finally {
    globalThis.logger = previousLogger
  }
}
