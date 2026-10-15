import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const moduleUrl = new URL('../output/runtime/extensions/installation/writer-lease.js', import.meta.url).href
const { acquireInstallationWriterLease: acquire } = await import(moduleUrl)
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yui-chat-writer-'))
const file = path.join(root, 'installation-writer.json')
const read = () => fs.readFile(file, 'utf8').then(JSON.parse)
const missing = () => assert.rejects(fs.access(file), { code: 'ENOENT' })
const active = { code: 'INSTALLATION_WRITER_ALREADY_ACTIVE' }
const childSource = `
  import assert from 'node:assert/strict'
  import fs from 'node:fs/promises'
  const { acquireInstallationWriterLease: acquire } = await import(${JSON.stringify(moduleUrl)})
  const file = process.argv[1], mode = process.argv[2]
  if (mode === 'blocked') {
    await assert.rejects(acquire(file), { code: 'INSTALLATION_WRITER_ALREADY_ACTIVE' })
  } else if (mode === 'execve') {
    if (!process.execve) {
      console.log('skip execve: unsupported Node/platform')
    } else {
      await acquire(file)
      process.on('exit', () => console.log('unexpected old exit callback'))
      process.execve(process.execPath, [process.execPath, ...process.execArgv, file, 'after-execve', String(process.pid)], process.env)
    }
  } else if (mode === 'after-execve') {
    assert.equal(process.pid, Number(process.argv[3]))
    const prior = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.equal(prior.pid, process.pid)
    const release = await acquire(file)
    assert.notEqual(JSON.parse(await fs.readFile(file, 'utf8')).nonce, prior.nonce)
    await release()
    console.log('ok actual execve: same PID, new runtime reclaimed its lease')
  } else if (mode === 'leave') {
    await acquire(file)
  } else if (mode === 'reclaim') {
    await (await acquire(file))()
  }
`
function child(mode) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', childSource, file, mode], { encoding: 'utf8', timeout: 15000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.trim()
}

try {
  const release = await acquire(file)
  const original = await read()
  await assert.rejects(acquire(file), active)
  const duplicate = await import(`${moduleUrl}?duplicate-runtime-import`)
  await assert.rejects(duplicate.acquireInstallationWriterLease(file), active)
  const alias = path.join(root, 'alias')
  await fs.symlink(root, alias, 'dir')
  await assert.rejects(acquire(path.join(alias, path.basename(file))), active)
  child('blocked')
  assert.deepEqual(await read(), original, 'contenders do not change an active lease')
  await Promise.all([release(), release()])
  await missing()
  await release()
  await (await acquire(file))()

  const originalOpen = fs.open
  const canonicalFile = path.join(await fs.realpath(root), path.basename(file))
  try {
    fs.open = async (...args) => {
      const handle = await originalOpen(...args)
      if (args[0] === canonicalFile && args[1] === 'wx') {
        const write = handle.writeFile.bind(handle)
        handle.writeFile = async () => {
          await write('{partial')
          throw Object.assign(new Error('injected lease write failure'), { code: 'ENOSPC' })
        }
      }
      return handle
    }
    await assert.rejects(acquire(file), { code: 'ENOSPC' })
    await missing()
  } finally { fs.open = originalOpen }
  await (await acquire(file))()

  await fs.writeFile(file, JSON.stringify({ pid: process.pid, nonce: 'legacy-pre-execve' }))
  await (await acquire(file))()
  await missing()

  child('leave')
  await (await acquire(file))()
  await missing()

  // An older lease has no process identity: a different live PID stays protected.
  await fs.writeFile(file, JSON.stringify({ pid: process.pid, nonce: 'legacy-live-owner' }))
  child('blocked')
  await fs.unlink(file)
  if (process.platform === 'linux' && original.processIdentity) {
    await fs.writeFile(file, JSON.stringify({ pid: process.pid, nonce: 'reused-pid', processIdentity: 'different-boot-or-start' }))
    child('reclaim')
    await missing()
  }

  const releaseOld = await acquire(file)
  const replacement = { pid: process.pid, nonce: 'replacement-owner' }
  await fs.writeFile(file, JSON.stringify(replacement))
  await releaseOld()
  assert.deepEqual(await read(), replacement, 'release never deletes another nonce')
  await fs.unlink(file)

  await fs.writeFile(file, '{broken')
  await assert.rejects(acquire(file), { code: 'INSTALLATION_WRITER_INVALID_LEASE' })
  assert.equal(await fs.readFile(file, 'utf8'), '{broken', 'invalid leases fail closed')
  await fs.unlink(file)
  await (await acquire(file))()

  const output = child('execve')
  assert.ok(!output.includes('unexpected old exit callback'))
  console.log(output)
  await missing()
  console.log('ok installation writer: runtime ownership, duplicate imports, cross-process exclusion, legacy/dead leases, PID reuse and nonce-safe release')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
