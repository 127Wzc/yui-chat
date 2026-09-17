import { onBeforeUnmount, onMounted, ref, watch } from "vue"

type Editor = {
  getValue(): string
  setValue(value: string): void
  on(event: "change", callback: () => void): void
  getDoc(): { replaceRange(value: string, from: { line: number; ch: number }, to: { line: number; ch: number }, origin: string): void }
  lastLine(): number
  getLine(line: number): string
  execCommand(command: string): void
  undo(): void
  refresh(): void
  toTextArea(): void
}
type EditorLibrary = { fromTextArea(input: HTMLTextAreaElement, options: Record<string, unknown>): Editor }
type EditorGlobals = typeof globalThis & { CodeMirror?: EditorLibrary; js_beautify?: (source: string, options: Record<string, unknown>) => string }
const assets = new Map<string, Promise<void>>()
function loadAsset(name: string): Promise<void> {
  const existing = assets.get(name)
  if (existing) return existing
  const promise = new Promise<void>((resolve, reject) => {
    const url = new URL(`../vendor/code-editor/${name}`, import.meta.url).href
    const node = name.endsWith(".css") ? document.createElement("link") : document.createElement("script")
    if (node instanceof HTMLLinkElement) { node.rel = "stylesheet"; node.href = url }
    else node.src = url
    node.onload = () => resolve()
    node.onerror = () => { node.remove(); assets.delete(name); reject(new Error("编辑器组件加载失败，请重新打开编辑窗口。")) }
    document.head.append(node)
  })
  assets.set(name, promise)
  return promise
}
async function loadEditor(): Promise<EditorLibrary> {
  await Promise.all([loadAsset("codemirror.min.js"), loadAsset("codemirror.min.css"), loadAsset("foldgutter.min.css")])
  await Promise.all(["javascript", "matchbrackets", "foldcode"].map(name => loadAsset(`${name}.min.js`)))
  await Promise.all(["foldgutter", "brace-fold", "comment-fold"].map(name => loadAsset(`${name}.min.js`)))
  return (globalThis as EditorGlobals).CodeMirror!
}

export const CodeEditor = {
  name: "CodeEditor",
  props: { modelValue: { type: String, default: "" }, label: { type: String, default: "JavaScript" } },
  emits: ["update:modelValue"],
  setup(props: { modelValue: string; label: string }, { emit }: { emit: (event: "update:modelValue", value: string) => void }) {
    const input = ref<HTMLTextAreaElement | null>(null)
    const ready = ref(false), busy = ref(false), error = ref("")
    const canUndoFormat = ref(false)
    let editor: Editor | undefined, observer: ResizeObserver | undefined, disposed = false, syncing = false
    onMounted(async () => {
      try {
        const library = await loadEditor()
        if (disposed || !input.value) return
        input.value.value = props.modelValue
        editor = library.fromTextArea(input.value, {
          mode: "javascript", theme: "yui", lineNumbers: true, matchBrackets: true,
          foldGutter: true, gutters: ["CodeMirror-linenumbers", "CodeMirror-foldgutter"],
          indentUnit: 2, tabSize: 2, indentWithTabs: false, lineWrapping: false,
          screenReaderLabel: props.label,
          extraKeys: { Tab: "indentMore", "Shift-Tab": "indentLess", "Ctrl-Q": "fold", "Cmd-Q": false },
        })
        editor.on("change", () => {
          canUndoFormat.value = false
          if (!syncing) { emit("update:modelValue", editor!.getValue()); error.value = "" }
        })
        observer = new ResizeObserver(() => editor?.refresh())
        observer.observe(input.value.parentElement!)
        ready.value = true
      } catch (cause) { error.value = cause instanceof Error ? cause.message : "编辑器加载失败，可继续在文本框编辑。" }
    })
    watch(() => props.modelValue, value => {
      if (!editor || editor.getValue() === value) return
      syncing = true
      try { editor.setValue(value) } finally { syncing = false }
    })
    onBeforeUnmount(() => { disposed = true; observer?.disconnect(); editor?.toTextArea(); editor = undefined })
    async function format() {
      if (!editor) return
      const source = editor.getValue()
      busy.value = true; error.value = ""
      try {
        await loadAsset("beautify.min.js")
        if (disposed || !editor) return
        if (editor.getValue() !== source) { error.value = "代码已继续编辑，请重新格式化。"; return }
        const formatted = (globalThis as EditorGlobals).js_beautify!(source, { indent_size: 2, end_with_newline: true, preserve_newlines: true })
        if (formatted === source) return
        editor.getDoc().replaceRange(formatted, { line: 0, ch: 0 }, { line: editor.lastLine(), ch: editor.getLine(editor.lastLine()).length }, "format")
        canUndoFormat.value = true
      } catch (cause) { error.value = `未修改代码：${cause instanceof Error ? cause.message : "格式化失败"}` }
      finally { busy.value = false }
    }
    function undoFormat() { editor?.undo(); canUndoFormat.value = false }
    function fold(all: boolean) { editor?.execCommand(all ? "foldAll" : "unfoldAll") }
    function fallbackChange(event: Event) { emit("update:modelValue", (event.target as HTMLTextAreaElement).value) }
    return { input, ready, busy, error, canUndoFormat, format, undoFormat, fold, fallbackChange }
  },
  template: `
    <div class="source-code-editor">
      <div class="source-code-toolbar"><span class="source-code-label">{{ label }}</span>
        <button type="button" class="btn small outline" :disabled="!ready" @click="fold(true)">折叠</button>
        <button type="button" class="btn small outline" :disabled="!ready" @click="fold(false)">展开</button>
        <button v-if="canUndoFormat" type="button" class="btn small outline" @click="undoFormat">撤销格式化</button>
        <button type="button" class="btn small outline" :disabled="!ready || busy" @click="format">{{ busy ? '格式化中…' : '格式化' }}</button>
      </div>
      <div class="source-code-body"><textarea ref="input" :value="modelValue" :aria-label="label" spellcheck="false" @input="fallbackChange"></textarea></div>
      <p class="muted tiny">点击行号旁的箭头折叠代码；光标移到括号旁可查看配对。格式化只调整排版，不校验语法。</p>
      <pre v-if="error" class="source-code-error" role="status">{{ error }}</pre>
    </div>`,
}
