/** Schema 变量表单：渠道、独立工具和扩展复用相同的字段与凭证展示。 */
export const RuntimeVariableFields = {
  name: "RuntimeVariableFields",
  props: { rows: { type: Array, default: () => [] }, draft: { type: Object, required: true } },
  template: `<template v-for="row in rows" :key="row.name"><Field v-if="row.kind === 'select'" :label="row.label" type="select" :options="row.options" v-model="draft[row.name]" :tip="row.tip" /><Field v-else-if="row.kind === 'number'" :label="row.label" type="number" :placeholder="row.placeholder" v-model="draft[row.name]" :tip="row.tip" /><Field v-else-if="row.kind === 'textarea'" :label="row.label" type="textarea" :rows="3" :placeholder="row.placeholder" v-model="draft[row.name]" :tip="row.tip" /><Field v-else :label="row.label" :type="row.kind === 'secret' ? 'password' : 'text'" :placeholder="row.placeholder" v-model="draft[row.name]" :tip="row.tip" /></template>`,
}
