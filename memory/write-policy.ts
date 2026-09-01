interface MemoryWriteOptions {
  explicitRequired?: boolean
  source?: unknown
}

const sensitiveKeyword = /(?:密码|口令|token|api[_ -]?key|密钥|cookie|authorization|登录凭证|银行卡|信用卡|支付(?:密码|账号)|身份证(?:件)?号|护照号|(?:bank|credit)[_ -]?card|card[_ -]?(?:number|no)|cvv|id[_ -]?card|passport[_ -]?(?:number|no))/i
const phoneLikeChunk = /[+()\d][+()\d\s.\-]{8,30}[\d)]/g
const oneTimeCode = /(?:验证码|校验码|动态码|短信码|otp|one[_ -]?time[_ -]?(?:password|code))\s*(?:是|为|[:：=])?\s*([a-z\d](?:[\s-]?[a-z\d]){3,9})\b|\b([a-z\d](?:[\s-]?[a-z\d]){3,9})\s*(?:是|为|[:：=])?\s*(?:验证码|校验码|动态码|短信码|otp)/i
// 15 位旧证件号要求第 9-12 位是合法出生月日，避免把订单号等任意 15 位数字误判成证件号。
const identityNumber = /(?:^|[^\d])(?:\d{6}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]|\d{8}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3})(?!\d)/
const preciseAddress = /(?:(?:住址|家庭地址|收货地址|联系地址|详细地址|家庭住址|现住址|我住在|我家在|居住于|居住地址)\s*[:：]?\s*)[^，。；;\n]{0,120}(?:(?:路|街|道|巷|弄|村|小区)|\d+\s*(?:号|号楼|栋|幢|单元|室))|(?:省|自治区|市)[^，。；;\n]{0,40}(?:区|县)[^，。；;\n]{0,60}(?:(?:路|街|道|巷|弄|村|小区)|\d+\s*(?:号|号楼|栋|幢|单元|室))/
const explicit = /(?:请|帮我|麻烦你)?(?:记住|记下|保存|别忘了|以后叫我)/

function compactDigits(value: unknown = ""): string { return String(value || "").replace(/[^\d]/g, "") }

function containsMobileNumber(value: unknown = ""): boolean {
  for (const candidate of String(value || "").match(phoneLikeChunk) || []) {
    const digits = compactDigits(candidate)
    const local = digits.startsWith("86") && digits.length === 13 ? digits.slice(2) : digits
    if (/^1[3-9]\d{9}$/.test(local)) return true
  }
  return false
}

function isPaymentCard(value: unknown = ""): boolean {
  const digits = compactDigits(value)
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  let alternate = false
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index])
    if (alternate) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    alternate = !alternate
  }
  return sum > 0 && sum % 10 === 0
}

export function containsSensitiveMemoryData(value: unknown = ""): boolean {
  const text = String(value || "")
  if (sensitiveKeyword.test(text) || containsMobileNumber(text) || oneTimeCode.test(text) || identityNumber.test(text) || preciseAddress.test(text)) return true
  // 只把原文中近似一整段卡号的数字串交给 Luhn，避免把多个无关数字拼接后误判。
  return (text.match(/(?:^|[^\d])(?:\d[\s-]?){13,19}(?!\d)/g) || []).some(candidate => isPaymentCard(candidate))
}

export function isExplicitMemoryIntent(value: unknown = ""): boolean { return explicit.test(String(value || "")) }
export function validateMemoryWrite(value: unknown = "", { explicitRequired = false, source = "" }: MemoryWriteOptions = {}): string {
  const text = String(value || "").replace(/\s+/g, " ").trim()
  if (!text) throw new Error("记忆内容不能为空。")
  if (containsSensitiveMemoryData(text)) throw new Error("为保护隐私，密码、验证码、完整联系方式、精确住址、支付或证件信息不能保存为记忆。")
  if (explicitRequired && source !== "manual" && !isExplicitMemoryIntent(text)) throw new Error("长期记忆只能由用户明确提出“记住/记下”等意图后写入。")
  return text.slice(0, 500)
}
