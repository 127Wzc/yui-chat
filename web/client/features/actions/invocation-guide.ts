export const InvocationGuide = {
  props: { kind: String, callStyle: String, prefix: String },
  template: `
    <details class="actions-fold" open>
      <summary>调用流程示例<span>演示配置，不会实际执行</span><Icon name="chevron-down" :size="13" /></summary>
      <ol class="actions-call-guide">
        <template v-if="kind==='tool'">
          <li><b>收到指令</b><p>用户发送 <code>{{prefix}}示例搜索 今日天气</code>。</p></li>
          <li><b>绑定参数</b><p>选择 web_search，把文字填到 query，默认参数填写 source: auto。</p><pre>{"query":"今日天气","source":"auto"}</pre></li>
          <li><b>执行工具</b><p>校验动作权限与参数后，调用内置 web_search。该工具需要先启用搜索渠道；不会额外调用模型整理答案。</p></li>
          <li><b>回复结果</b><p>先选择“格式化 JSON”查看返回结构；需要精简时，在回复步骤粘贴真实返回值并选择字段。图片或消息体通过对应回复方式发送。</p></li>
        </template>
        <template v-else-if="callStyle==='resource'">
          <li><b>选择资源</b><p>选择一个 JSON 文件，调用方式选“读取 JSON / 文本文件”。例如文件内容：</p><pre>{"data":{"text":"欢迎使用"}}</pre></li>
          <li><b>收到指令并读取</b><p>用户发送配置好的指令后，检查权限，再通过已声明的框架资源读取文件；此方式不调用函数，也不需要默认要求。</p></li>
          <li><b>提取并回复</b><p>回复方式选“纯文本 / 提取字段”，字段填 <code>data.text</code>，用户收到“欢迎使用”。文本文件则留空字段路径。</p></li>
        </template>
        <template v-else>
          <li><b>选择已有资源</b><p>填写文件的实际导出名称；参数与初始化要求需符合该资源的接口。</p></li>
          <li><b>传入参数</b><p v-if="callStyle==='plugin'">新建插件实例，设置 this.e，调用指定方法 (e, args, context)。</p><p v-else>调用导出函数 (args, context)。args 来自配置参数，context.e 为当前消息事件。</p></li>
          <li><b>提取回复</b><p>若返回 {"data":{"text":"完成"}}，回复字段填 data.text，即发送“完成”。已自行回复时不再重复发送。</p></li>
        </template>
      </ol>
      <p class="muted small">先在“测试”步骤预览当前动作的真实参数；只有“实际试跑”才会执行已保存且启用的动作。源码若已调用 context.e.reply()，系统不会再追加相同结果。</p>
    </details>
  `,
}
