import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { MongoClient } from 'mongodb'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { createApp } from '../src/app.js'
import { createTestAppConfig } from './helpers/helper.js'

vi.mock('bullmq', () => ({
  Queue: class {
    add = vi.fn()
    on = vi.fn()
    close = vi.fn(async () => undefined)
  },
  Worker: class {
    on = vi.fn()
    waitUntilReady = vi.fn(async () => undefined)
    run = vi.fn(async () => undefined)
    close = vi.fn(async () => undefined)
  },
}))

afterEach(() => vi.restoreAllMocks())

describe('application lifecycle', () => {
  it('returns a native app and lets Fastify own service startup and cleanup', async () => {
    const dispose = vi.spyOn(MongoClient.prototype, 'close')
    const settings = await createTestAppConfig(false, 0).load().runPromise()
    const app = createApp(settings)
    expect(app.log.level).toBe('error')
    expect(app.server.listening).toBe(false)
    expect(app.hasDecorator('services')).toBe(false)
    try {
      await app.ready()
      expect(app.server.listening).toBe(false)
      expect(app.hasDecorator('services')).toBe(true)
      expect(dispose).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
    expect(dispose).toHaveBeenCalledOnce()
  })
})

const startExecutable = (moduleSource: string, port = '0') => {
  const entry = new URL('../src/index.ts', import.meta.url).href
  const mockApp = `data:text/javascript,${encodeURIComponent(moduleSource)}`
  return spawn(
    process.execPath,
    [
      '--import',
      'vite-plus/register',
      '--input-type=module',
      '-e',
      `
      import { registerHooks } from 'node:module'
      registerHooks({ resolve(specifier, context, nextResolve) {
        if (specifier === './app.js' && context.parentURL === ${JSON.stringify(entry)})
          return { url: ${JSON.stringify(mockApp)}, shortCircuit: true }
        return nextResolve(specifier, context)
      } })
      await import(${JSON.stringify(entry)})
    `,
    ],
    {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: { ...process.env, NODE_OPTIONS: '', PORT: port, HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
}

describe('executable startup', () => {
  it.each([false, true])(
    'closes after listen fails, including when cleanup fails (%s)',
    async (failClose) => {
      const child = startExecutable(
        `
      export const createApp = () => ({
        listen: async ({ host, port }) => {
          console.log('listening', host, port)
          throw new Error('listen failed')
        },
        close: async () => {
          console.log('closed')
          if (${failClose}) throw new Error('cleanup failed')
        }
      })
    `,
        '4321',
      )
      let output = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => {
        output += String(chunk)
      })
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      expect(code).toBe(1)
      expect(output.trim().split('\n')).toEqual(['listening 127.0.0.1 4321', 'closed'])
      expect(stderr).toContain('listen failed')
      if (failClose) {
        expect(stderr).toContain('cleanup failed')
      }
    },
  )

  it('rejects invalid configuration before creating Fastify', async () => {
    const child = startExecutable(
      `
      export const createApp = () => { console.log('created') }
    `,
      '-1',
    )
    let output = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    expect(code).toBe(1)
    expect(stderr).toContain('Invalid application configuration')
    expect(output).toBe('')
  })
})

describe.skipIf(process.platform === 'win32')('executable shutdown', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)(
    'handles %s during startup and repeated signals during cleanup',
    async (signal) => {
      const child = startExecutable(`
        export const createApp = () => ({
          listen: async () => {
            console.log('starting')
            await new Promise(resolve => setTimeout(resolve, 150))
          },
          close: async () => {
            console.log('closing')
            await new Promise(resolve => setTimeout(resolve, 150))
            console.log('closed')
          }
        })
      `)
      let output = ''
      let stderr = ''
      let interrupted = false
      let repeated = false
      child.stdout.on('data', (chunk) => {
        output += String(chunk)
        if (!interrupted && output.includes('starting')) {
          interrupted = true
          child.kill(signal)
        }
        if (!repeated && output.includes('closing')) {
          repeated = true
          child.kill(signal)
        }
      })
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })
      const deadline = setTimeout(() => {
        child.kill('SIGKILL')
      }, 5000)
      try {
        const status = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve, reject) => {
            child.once('error', reject)
            child.once('close', (code, exitSignal) => {
              resolve({ code, signal: exitSignal })
            })
          },
        )
        expect(stderr).toBe('')
        expect(status.code).toBe(0)
        expect(status.signal).toBeNull()
        expect(output.trim().split('\n')).toEqual(['starting', 'closing', 'closed'])
        expect(interrupted && repeated).toBe(true)
      } finally {
        clearTimeout(deadline)
        child.kill('SIGKILL')
      }
    },
    10_000,
  )
})
