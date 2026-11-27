export interface CreateUrlInput {
  readonly originalUrl: string
  readonly customAlias?: string
  readonly expiresAt?: Date
}

export interface Url {
  id: string
  shortCode: string
  originalUrl: string
  customAlias?: string
  accessCount: number
  lastAccessedAt?: Date
  expiresAt?: Date
  isActive: boolean
  deletedAt?: Date
  createdAt: Date
  updatedAt: Date
}

export interface CachedUrl {
  readonly id: string
  readonly shortCode: string
  readonly originalUrl: string
  readonly expiresAt?: string
}
