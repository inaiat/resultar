import type { ObjectId } from 'mongodb'

export interface CreateUrlRequest {
  readonly originalUrl: string
  readonly customAlias?: string
  readonly expiresAt?: string
}

export interface UrlResponse {
  id: string
  shortCode: string
  originalUrl: string
  customAlias?: string
  createdAt: string
  lastAccessedAt?: string | null
  accessCount: number
  expiresAt?: string | null
  isActive: boolean
}

export interface UrlDocument {
  _id?: ObjectId
  shortCode: string
  originalUrl: string
  customAlias?: string
  accessCount: number
  lastAccessedAt?: Date
  expiresAt?: Date
  isActive: boolean
  deletedAt?: Date
  createdAt?: Date
  updatedAt?: Date
}

export interface CachedUrl {
  id: string
  shortCode: string
  originalUrl: string
  expiresAt?: string
}
