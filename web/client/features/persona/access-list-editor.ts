interface AccessListDraft {
  groups: string
  users: string
  groupUsers: string
}

function entries(value: unknown): string[] {
  return (Array.isArray(value) ? value.map(item => String(item ?? "")) : String(value ?? "").split(/[,，;；|\s]+/))
    .map(item => item.trim()).filter(Boolean)
}

/** 将现有名单按运行时匹配规则分栏，纯数字仍保留为群号。 */
export function accessListDraft(value: unknown): AccessListDraft {
  const groups: string[] = []
  const users: string[] = []
  const groupUsers: string[] = []
  for (const item of entries(value)) {
    if (item.startsWith("^")) users.push(item.slice(1))
    else if (item.includes("^")) groupUsers.push(item)
    else groups.push(item)
  }
  return { groups: groups.join(", "), users: users.join(", "), groupUsers: groupUsers.join(", ") }
}

/** 页面自动编码用户项；校验栏位，避免把用户或群范围填入错误的位置。 */
export function accessListValue(draft: AccessListDraft, label: string): string[] {
  const groups = entries(draft.groups)
  const users = entries(draft.users)
  const groupUsers = entries(draft.groupUsers)
  if (groups.some(item => item.includes("^"))) throw new Error(`${label}的群号栏只填写群号。`)
  if (users.some(item => item.includes("^"))) throw new Error(`${label}的用户栏只填写 QQ 号，无需添加 ^ 或群号。`)
  if (groupUsers.some(item => !/^[^^]+\^[^^]+$/.test(item))) throw new Error(`${label}的指定群成员请按“群号^QQ号”填写。`)
  return [...new Set([...groups, ...users.map(item => `^${item}`), ...groupUsers])]
}
