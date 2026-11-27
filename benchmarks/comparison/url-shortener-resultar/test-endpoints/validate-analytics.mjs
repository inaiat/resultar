#!/usr/bin/env node

const DEFAULT_BASE_URL = process.env.BASE_URL || 'http://localhost:3000'
const DEFAULT_TIMEOUT_MS = Number(process.env.ANALYTICS_TIMEOUT_MS || 12000)
const DEFAULT_POLL_INTERVAL_MS = Number(process.env.ANALYTICS_POLL_INTERVAL_MS || 250)
const DEFAULT_REQUEST_TIMEOUT_MS = Number(process.env.ANALYTICS_REQUEST_TIMEOUT_MS || 5000)

const baseUrl = normalizeBaseUrl(readArg('--base-url') || DEFAULT_BASE_URL)

main().catch((error) => {
  console.error('')
  console.error('Fatal error:')
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})

async function main() {
  const results = []

  console.log(`Base URL: ${baseUrl}`)
  console.log('')

  await waitForServiceReady()

  results.push(await runScenario('GET /health returns service metadata', testHealth))

  const fixtures = await runScenario('POST /api/v1 creates analytics fixtures', createFixtures)
  results.push(fixtures)

  if (fixtures.ok) {
    results.push(
      await runScenario('GET /api/v1/stats?type=recent orders links by creation time', () =>
        testRecentOrdering(fixtures.data),
      ),
    )
    results.push(
      await runScenario('Redirects increment access counts and lastAccessedAt', () =>
        testRedirectCounters(fixtures.data),
      ),
    )
    results.push(
      await runScenario('GET /api/v1/stats?type=popular orders links by access count', () =>
        testPopularOrdering(fixtures.data),
      ),
    )
    results.push(
      await runScenario('Deleted URLs disappear from active analytics', () =>
        testDeletedUrlExcluded(fixtures.data[0]),
      ),
    )
  } else {
    results.push(skipScenario('GET /api/v1/stats?type=recent orders links by creation time'))
    results.push(skipScenario('Redirects increment access counts and lastAccessedAt'))
    results.push(skipScenario('GET /api/v1/stats?type=popular orders links by access count'))
    results.push(skipScenario('Deleted URLs disappear from active analytics'))
  }

  const expiring = await runScenario('POST /api/v1 creates an expiring analytics fixture', () =>
    createUrl({
      originalUrl: `https://example.com/analytics-expiring-${Date.now()}`,
      expiresAt: new Date(Date.now() + 2500).toISOString(),
    }),
  )
  results.push(expiring)

  if (expiring.ok) {
    results.push(
      await runScenario('Expired URLs return 410 and disappear from active analytics', () =>
        testExpiredUrlExcluded(expiring.data),
      ),
    )
  } else {
    results.push(skipScenario('Expired URLs return 410 and disappear from active analytics'))
  }

  results.push(await runScenario('GET /api/v1/stats defaults to recent limit 10', testStatsDefault))
  results.push(await runScenario('GET /api/v1/stats rejects invalid type', testStatsInvalidType))
  results.push(await runScenario('GET /api/v1/stats rejects invalid limit 0', testStatsLimitZero))
  results.push(
    await runScenario('GET /api/v1/stats rejects invalid limit above 100', testStatsLimitTooLarge),
  )

  printSummary(results)
}

async function testHealth() {
  const response = await request('/health')
  expectStatus(response, [200], 'health endpoint')

  const body = await response.json()
  assert(isPlainObject(body), 'health response must be an object')
  assert(
    typeof body.ok === 'number' && Number.isFinite(body.ok),
    'health.ok must be a finite number',
  )
}

async function createFixtures() {
  const created = []
  const timestamp = Date.now()

  for (let index = 0; index < 3; index += 1) {
    await sleep(20)
    created.push(
      await createUrl({ originalUrl: `https://example.com/analytics-${timestamp}-${index}` }),
    )
  }

  return created.map((url, index) => ({ ...url, expectedAccessCount: index + 1 }))
}

async function createUrl(payload) {
  const response = await request('/api/v1', { method: 'POST', json: payload })
  expectStatus(response, [201], 'create URL')

  const body = await response.json()
  return validateUrlPayload(body, payload)
}

async function testRecentOrdering(fixtures) {
  const body = await fetchStats('recent', 10)
  const expectedOrder = fixtures
    .slice()
    .reverse()
    .map((fixture) => fixture.shortCode)
  const actualOrder = body.data.map((item) => item.shortCode)

  assertContainsSubsequence(
    actualOrder,
    expectedOrder,
    'recent stats should contain fixtures in descending creation order',
  )
}

async function testRedirectCounters(fixtures) {
  for (const fixture of fixtures) {
    for (let index = 0; index < fixture.expectedAccessCount; index += 1) {
      await redirectToOriginalUrl(fixture)
    }
  }

  await eventually('access counters should update analytics', async () => {
    const indexed = await fetchIndexedStats('popular', 100)

    for (const fixture of fixtures) {
      const item = indexed.get(fixture.shortCode)
      assert(item !== undefined, `stats should contain '${fixture.shortCode}'`)
      assert(
        item.accessCount === fixture.expectedAccessCount,
        `expected ${fixture.shortCode} accessCount ${fixture.expectedAccessCount}, got ${item.accessCount}`,
      )
      assert(
        typeof item.lastAccessedAt === 'string',
        `${fixture.shortCode} must have lastAccessedAt after redirects`,
      )
    }
  })
}

async function testPopularOrdering(fixtures) {
  const body = await fetchStats('popular', 100)
  const expectedOrder = fixtures
    .slice()
    .sort((left, right) => right.expectedAccessCount - left.expectedAccessCount)
    .map((fixture) => fixture.shortCode)
  const actualOrder = body.data.map((item) => item.shortCode)

  assertContainsSubsequence(
    actualOrder,
    expectedOrder,
    'popular stats should contain fixtures in descending access-count order',
  )
}

async function testDeletedUrlExcluded(fixture) {
  const response = await request(`/api/v1/${encodeURIComponent(fixture.shortCode)}/delete`, {
    method: 'POST',
  })
  expectStatus(response, [200], 'delete analytics fixture')

  await eventually('deleted URL should disappear from active analytics', async () => {
    const indexed = await fetchIndexedStats('recent', 100)
    assert(indexed.get(fixture.shortCode) === undefined, 'deleted URL is still listed in stats')
  })
}

async function testExpiredUrlExcluded(fixture) {
  await eventually(
    'expired URL should return 410',
    async () => {
      const response = await request(`/api/v1/${encodeURIComponent(fixture.shortCode)}`, {
        redirect: 'manual',
      })
      expectStatus(response, [410], 'redirect expired URL')
      await validateErrorResponse(response, 'redirect expired URL')
    },
    { timeoutMs: 16000 },
  )

  await eventually('expired URL should disappear from active analytics', async () => {
    const indexed = await fetchIndexedStats('recent', 100)
    assert(indexed.get(fixture.shortCode) === undefined, 'expired URL is still listed in stats')
  })
}

async function testStatsDefault() {
  const body = await fetchStats(undefined, undefined)
  assert(body.data.length <= 10, 'default stats length must be <= 10')
}

async function testStatsInvalidType() {
  const response = await request('/api/v1/stats?type=invalid')
  expectStatus(response, [400], 'invalid stats type')
  await validateErrorResponse(response, 'invalid stats type')
}

async function testStatsLimitZero() {
  const response = await request('/api/v1/stats?limit=0')
  expectStatus(response, [400], 'invalid stats limit 0')
  await validateErrorResponse(response, 'invalid stats limit 0')
}

async function testStatsLimitTooLarge() {
  const response = await request('/api/v1/stats?limit=101')
  expectStatus(response, [400], 'invalid stats limit 101')
  await validateErrorResponse(response, 'invalid stats limit 101')
}

async function redirectToOriginalUrl(fixture) {
  const response = await request(`/api/v1/${encodeURIComponent(fixture.shortCode)}`, {
    redirect: 'manual',
  })
  expectStatus(response, [301, 302, 303, 307, 308], 'redirect URL')

  const location = response.headers.get('location')
  assert(location === fixture.originalUrl, 'redirect Location must match originalUrl')
}

async function fetchIndexedStats(type, limit) {
  const body = await fetchStats(type, limit)
  return new Map(body.data.map((item) => [item.shortCode, item]))
}

async function fetchStats(type, limit) {
  const params = new URLSearchParams()
  if (type !== undefined) {
    params.set('type', type)
  }
  if (limit !== undefined) {
    params.set('limit', String(limit))
  }

  const suffix = params.size > 0 ? `?${params.toString()}` : ''
  const response = await request(`/api/v1/stats${suffix}`)
  expectStatus(response, [200], `stats ${suffix || '(default)'}`)

  const body = await response.json()
  validateStatsPayload(body)
  return body
}

async function waitForServiceReady() {
  await eventually('service readiness', async () => {
    const response = await request('/health')
    expectStatus(response, [200], 'service readiness')
  })
}

async function request(pathname, options = {}) {
  const headers = new Headers(options.headers || {})
  let body = options.body
  const method = options.method || 'GET'
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, timeoutMs)

  if (options.json !== undefined) {
    headers.set('content-type', 'application/json')
    body = JSON.stringify(options.json)
  }

  try {
    return await fetch(`${baseUrl}${pathname}`, {
      method,
      headers,
      body,
      redirect: options.redirect || 'follow',
      signal: controller.signal,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`${method} ${pathname} timed out after ${timeoutMs}ms`)
    }

    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function validateErrorResponse(response, label) {
  const body = await response.json()
  assert(isPlainObject(body), `${label} error response must be an object`)

  const hasError = typeof body.error === 'string' && body.error.length > 0
  const hasMessage =
    typeof body.message === 'string' || (Array.isArray(body.message) && body.message.length > 0)
  const hasStatusCode = typeof body.statusCode === 'number'

  assert(hasError || hasMessage || hasStatusCode, `${label} must include error details`)
}

function validateUrlPayload(body, expected) {
  assert(isPlainObject(body), 'URL response must be an object')
  assert(body.success === true, 'URL response success must be true')
  assert(isPlainObject(body.data), 'URL response data must be an object')

  const url = body.data
  assert(typeof url.id === 'string' && url.id.length > 0, 'url.id must be a non-empty string')
  assert(
    typeof url.shortCode === 'string' && url.shortCode.length > 0,
    'url.shortCode must be a non-empty string',
  )
  assert(url.originalUrl === expected.originalUrl, 'url.originalUrl must match request')
  assert(typeof url.createdAt === 'string', 'url.createdAt must be a string')
  assert(typeof url.accessCount === 'number', 'url.accessCount must be a number')
  assert(url.accessCount === 0, 'new url.accessCount must be 0')
  assert(url.isActive === true, 'new URL must be active')

  if (expected.expiresAt !== undefined) {
    assert(typeof url.expiresAt === 'string', 'url.expiresAt must be present')
  }

  return url
}

function validateStatsPayload(body) {
  assert(isPlainObject(body), 'stats response must be an object')
  assert(body.success === true, 'stats.success must be true')
  assert(Array.isArray(body.data), 'stats.data must be an array')

  for (const item of body.data) {
    assert(isPlainObject(item), 'stats item must be an object')
    assert(typeof item.id === 'string' && item.id.length > 0, 'stats item.id must be a string')
    assert(
      typeof item.shortCode === 'string' && item.shortCode.length > 0,
      'stats item.shortCode must be a string',
    )
    assert(
      typeof item.originalUrl === 'string' && item.originalUrl.length > 0,
      'stats item.originalUrl must be a string',
    )
    assert(typeof item.createdAt === 'string', 'stats item.createdAt must be a string')
    assert(typeof item.accessCount === 'number', 'stats item.accessCount must be a number')
    assert(typeof item.isActive === 'boolean', 'stats item.isActive must be a boolean')
  }
}

async function runScenario(name, fn) {
  try {
    const data = await fn()
    console.log(`[PASS] ${name}`)
    return { name, ok: true, data }
  } catch (error) {
    console.log(`[FAIL] ${name}`)
    console.log(`       ${error instanceof Error ? error.message : String(error)}`)
    return { name, ok: false, error }
  }
}

function skipScenario(name) {
  console.log(`[SKIP] ${name}`)
  console.log('       depends on previous scenario')
  return { name, ok: false, skipped: true }
}

function printSummary(results) {
  const passed = results.filter((item) => item.ok).length
  const skipped = results.filter((item) => item.skipped).length
  const failed = results.filter((item) => !item.ok && !item.skipped).length

  console.log('')
  console.log('Summary')
  console.log(`  Passed: ${passed}`)
  console.log(`  Failed: ${failed}`)
  console.log(`  Skipped: ${skipped}`)

  if (failed > 0) {
    process.exitCode = 1
  }
}

async function eventually(label, fn, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const deadline = Date.now() + timeoutMs
  let lastError

  while (Date.now() <= deadline) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      await sleep(intervalMs)
    }
  }

  throw new Error(
    `${label} not satisfied within ${timeoutMs}ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}

function assertContainsSubsequence(actualValues, expectedValues, label) {
  let currentIndex = -1

  for (const expectedValue of expectedValues) {
    const nextIndex = actualValues.indexOf(expectedValue, currentIndex + 1)
    assert(
      nextIndex !== -1,
      `${label}: missing '${expectedValue}' in ${JSON.stringify(actualValues)}`,
    )
    currentIndex = nextIndex
  }
}

function readArg(flag) {
  const index = process.argv.indexOf(flag)
  if (index === -1) {
    return undefined
  }

  return process.argv[index + 1]
}

function normalizeBaseUrl(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function expectStatus(response, allowed, label) {
  assert(
    allowed.includes(response.status),
    `${label} expected status ${allowed.join(' or ')}, got ${response.status}`,
  )
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
