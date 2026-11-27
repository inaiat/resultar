import { tryResult, unit, type StrictResult } from 'resultar'

import type { CachedUrl, Url } from '../model/url.model.js'

import { InvalidCustomAliasError, InvalidUrlError } from '../errors/url.errors.js'

const supportedProtocols = new Set(['http:', 'https:'])
const customAliasPattern = /^[\w-]{1,50}$/u
const reservedAliases = new Set(['stats'])
const pad2 = Array.from({ length: 100 }, (_, value) => String(value).padStart(2, '0'))
const pad3 = Array.from({ length: 1000 }, (_, value) => String(value).padStart(3, '0'))
let cachedEpochSecond = Number.NaN
let cachedSecondPrefix = ''

export const formatIsoDate = (date: Date): string => {
  const ms = date.getTime()
  if (Number.isNaN(ms)) {
    return date.toISOString()
  }
  const epochSecond = Math.floor(ms / 1000)
  if (epochSecond !== cachedEpochSecond) {
    const year = date.getUTCFullYear()
    if (year < 0 || year > 9999) {
      return date.toISOString()
    }
    const yearString = year < 1000 ? String(year).padStart(4, '0') : String(year)
    cachedEpochSecond = epochSecond
    cachedSecondPrefix = `${yearString}-${pad2[date.getUTCMonth() + 1]}-${pad2[date.getUTCDate()]}T${pad2[date.getUTCHours()]}:${pad2[date.getUTCMinutes()]}:${pad2[date.getUTCSeconds()]}.`
  }
  return `${cachedSecondPrefix}${pad3[ms - epochSecond * 1000]}Z`
}

export const validateUrl = (url: string): StrictResult<URL, InvalidUrlError> => {
  const parsedUrl = tryResult({
    try: () => new URL(url),
    catch: () => new InvalidUrlError({ url }),
  })
  if (parsedUrl.isErr()) {
    return parsedUrl
  }
  if (!supportedProtocols.has(parsedUrl.value.protocol)) {
    return InvalidUrlError.err({ url })
  }
  return parsedUrl
}

export const validateCustomAlias = (
  alias: string | undefined,
): StrictResult<void, InvalidCustomAliasError> => {
  if (alias === undefined) {
    return unit()
  }
  if (!customAliasPattern.test(alias) || reservedAliases.has(alias.toLowerCase())) {
    return InvalidCustomAliasError.err({ alias })
  }
  return unit()
}

export const urlToCached = (url: Url): CachedUrl => ({
  id: url.id,
  shortCode: url.shortCode,
  originalUrl: url.originalUrl,
  expiresAt: url.expiresAt === undefined ? undefined : formatIsoDate(url.expiresAt),
})
