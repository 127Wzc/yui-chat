export const InvocationGuide = {
  props: { kind: String, callStyle: String, prefix: String },
  template: `
    <details class="actions-fold" open>
      <summary>调用流程示例<span>演示配置，不会实际执行</span><Icon name="chevron-down" :size="13" /></summary>
      <ol class="actions-call-guide">
        <template v-if="kind==='tool'">
          <li><b>收到指令</b><p>用户发送 <code>{{prefix}}示例搜索 今日天气</code>。</p></li>
          <li><b>绑定参数</b><p>选择 web_search，把文字填到 query，默认参数填写 source: auto。</p><pre>{"query":"今日天气","source":"auto"}</pre></li>
          <li><b>执行工具</b><p>校验角色、工具权限与参数后，经工具注册器调用 web_search。该工具需要先启用搜索渠道；不会额外调用模型整理答案。</p></li>
          <li><b>回复结果</b><p>先选择“格式化 JSON”查看返回结构；需要精简时，在回复步骤粘贴真实返回值并选择字段。图片或消息体通过对应回复方式发送。</p></li>
        </template>
        <template v-else-if="callStyle==='resource'">
          <li><b>选择资源</b><p>选择一个 JSON 文件，调用方式选“读取 JSON / 文本文件”。例如文件内容：</p><pre>{"data":{"text":"欢迎使用"}}</pre></li>
          <li><b>收到指令并读取</b><p>用户发送配置好的指令后，检查权限，再通过已声明的框架资源读取文件；此方式不调用函数，也不需要默认要求。</p></li>
          <li><b>提取并回复</b><p>回复方式选“纯文本 / 提取字段”，字段填 <code>data.text</code>，用户收到“欢迎使用”。文本文件则留空字段路径。</p></li>
        </template>
        <template v-else>
          <li><b>收到指令</b><p>演示指令为 <code>{{prefix}}示例问候 小明</code>，其中“小明”是指令后的输入。</p></li>
          <li><b>组成函数参数</b><p>把文字填到 text，默认要求留空，默认参数设置 prefix 为“你好”，得到：</p><pre>{"prefix":"你好","text":"小明"}</pre></li>
          <li v-if="callStyle==='plugin'"><b>创建插件实例并调用方法</b><p>项目文件导出名填 Handler，插件方法名填 run。框架创建实例，设置 this.e，再调用 run(e, args, context)。</p><pre>export class Handler {
  run(e, args, context) {
    return { data: { text: args.prefix + '，' + args.text + '！' } }
  }
}</pre><p>e / this.e 为当前消息事件。“用默认要求和补充文字作为方法收到的消息”开启时，仅替换 e.msg 与 raw_message。需要原插件初始化的复杂方法应先用 Custom 工具包装。</p></li>
          <li v-else><b>加载导出函数并调用</b><p>选择编译后的模块文件，导出名称填 greet，对象方法名留空。系统检查权限，再经注册器调用 greet(args, context)。</p><pre>export function greet(args, context) {
  return { data: { text: args.prefix + '，' + args.text + '！' } }
}</pre><p>args 是上一步参数；context.e 是当前消息事件，可读取用户、群等信息。模块只在执行时导入。</p></li>
          <li><b>把返回值变成回复</b><pre>{"data":{"text":"你好，小明！"}}</pre><p>回复方式选择“纯文本 / 提取字段”，提取字段填 <code>data.text</code>，最终发送“你好，小明！”。</p></li>
        </template>
      </ol>
      <p class="muted small">先在“测试”步骤预览当前动作的真实参数；只有“实际试跑”才会执行已保存且启用的动作。源码若已调用 context.e.reply()，系统不会再追加相同结果。</p>
    </details>
  `,
}
