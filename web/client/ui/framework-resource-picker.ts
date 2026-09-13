import { ref, watch } from "vue"
import { request } from "../app/store/store.js"
import { asRecord, asRecords, errorMessage, type UnknownRecord } from "../shared/data.js"

/** 使用现有受控资源目录 API；选取文件只声明引用，不导入或运行模块。 */
export const FrameworkResourcePicker = {
  name: "FrameworkResourcePicker",
  props: { open: Boolean },
  emits: ["close", "select"],
  setup(props: { open: boolean }, { emit }: { emit: (name: string, value?: unknown) => void }) {
    const folder = ref("plugins")
    const parent = ref("")
    const entries = ref<UnknownRecord[]>([])
    const loading = ref(false)
    const error = ref("")
    async function load(path = "plugins") {
      loading.value = true; error.value = ""
      try {
        const response = await request(`/api/extension-authoring/resources?path=${encodeURIComponent(path)}`)
        const result = asRecord(response.result)
        folder.value = String(result.path || ""); parent.value = String(result.parent || ""); entries.value = asRecords(result.entries)
      } catch (cause) { error.value = errorMessage(cause) } finally { loading.value = false }
    }
    function select(item: UnknownRecord) {
      if (item.kind === "directory") void load(String(item.path))
      else emit("select", item)
    }
    watch(() => props.open, open => { if (open) void load() })
    return { folder, parent, entries, loading, error, load, select }
  },
  template: `<SideDrawer :open="open" title="选择框架资源" subtitle="只声明选中的文件；不会导入或执行模块" icon="folder" width="540px" :modal="true" @close="$emit('close')"><div class="row"><button class="btn small outline" :disabled="!folder || loading" @click="load(parent)"><Icon name="chevron-left" :size="13" />上一级</button><code>{{ folder || 'Yunzai' }}</code></div><p v-if="error" class="form-error">{{ error }}</p><p v-if="loading" class="muted">正在读取目录…</p><div v-else class="actions-resource-list"><button v-for="item in entries" :key="item.path" class="btn outline" @click="select(item)"><Icon :name="item.kind==='directory'?'folder':'code'" :size="14" /><span>{{ item.name }}</span><small>{{ item.kind==='directory'?'打开目录':item.type }}</small></button></div><p class="muted tiny">运行数据、缓存和常见凭据文件不会显示。模块内的方法需要通过 Custom Tool 包装后使用。</p><template #actions><button class="btn outline" @click="$emit('close')">关闭</button></template></SideDrawer>`,
}
