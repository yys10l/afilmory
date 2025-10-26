import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

import { settings } from '@afilmory/db'
import { env } from '@afilmory/env'
import { EventEmitterService } from '@afilmory/framework'
import { BizException, ErrorCode } from 'core/errors'
import { and, eq, inArray } from 'drizzle-orm'
import { injectable } from 'tsyringe'

import { DbAccessor } from '../../database/database.provider'
import { getTenantContext } from '../tenant/tenant.context'
import { AES_ALGORITHM, AUTH_TAG_LENGTH, DEFAULT_SETTING_METADATA, IV_LENGTH } from './setting.constant'
import type { SettingKeyType, SettingRecord, SettingUiSchemaResponse, SettingValueMap } from './setting.type'
import { SETTING_UI_SCHEMA, SETTING_UI_SCHEMA_KEYS } from './setting.ui-schema'

export type SettingOption = {
  tenantId?: string
}

export type SetSettingOptions = {
  isSensitive?: boolean
  description?: string | null
} & SettingOption

declare module '@afilmory/framework' {
  interface Events {
    'setting.updated': { tenantId: string; key: string; value: string }
    'setting.deleted': { tenantId: string; key: string }
  }
}
type SettingEntryInput = {
  [K in SettingKeyType]: { key: K; value: SettingValueMap[K]; options?: SetSettingOptions }
}[SettingKeyType]

function isSettingKey(key: string): key is SettingKeyType {
  return key in DEFAULT_SETTING_METADATA
}

@injectable()
export class SettingService {
  private readonly encryptionKey: Buffer

  constructor(
    private readonly dbAccessor: DbAccessor,
    private readonly eventEmitter: EventEmitterService,
  ) {
    this.encryptionKey = createHash('sha256').update(env.CONFIG_ENCRYPTION_KEY).digest()
  }

  async get<K extends SettingKeyType>(key: K, options: SettingOption): Promise<SettingValueMap[K] | null>
  async get(key: string, options?: SettingOption): Promise<string | null> {
    const tenantId = this.resolveTenantId(options)
    const record = await this.findSettingRecord(key, tenantId)
    if (!record) {
      return null
    }
    const value = record.isSensitive ? this.decrypt(record.value) : record.value
    return value
  }

  async getMany<K extends readonly SettingKeyType[]>(
    keys: K,
    options?: SettingOption,
  ): Promise<{ [P in K[number]]: SettingValueMap[P] | null }>
  async getMany(keys: readonly string[], options?: SettingOption): Promise<Record<string, string | null>> {
    if (keys.length === 0) {
      return {}
    }

    const uniqueKeys = Array.from(new Set(keys))
    const tenantId = this.resolveTenantId(options)

    const db = this.dbAccessor.get()
    const records = await db
      .select()
      .from(settings)
      .where(and(eq(settings.tenantId, tenantId), inArray(settings.key, uniqueKeys)))

    const recordMap = new Map(records.map((record) => [record.key, record]))

    return uniqueKeys.reduce<Record<string, string | null>>((acc, key) => {
      const record = recordMap.get(key)
      if (!record) {
        acc[key] = null
        return acc
      }
      acc[key] = record.isSensitive ? this.decrypt(record.value) : record.value
      return acc
    }, {})
  }

  async set<K extends SettingKeyType>(key: K, value: SettingValueMap[K], options: SetSettingOptions): Promise<void>
  async set(key: string, value: string, options: SetSettingOptions): Promise<void>
  async set(key: string, value: string, options: SetSettingOptions): Promise<void> {
    const tenantId = this.resolveTenantId(options)
    const existing = await this.findSettingRecord(key, tenantId)
    const defaultMetadata = isSettingKey(key) ? DEFAULT_SETTING_METADATA[key] : undefined
    const isSensitive = options.isSensitive ?? defaultMetadata?.isSensitive ?? existing?.isSensitive ?? false
    const payload = isSensitive ? this.encrypt(value) : value
    const db = this.dbAccessor.get()

    const insertPayload: typeof settings.$inferInsert = {
      tenantId,
      key,
      value: payload,
      isSensitive,
    }

    const updatePayload: Partial<typeof settings.$inferInsert> = {
      value: payload,
      isSensitive,
      updatedAt: new Date().toISOString(),
    }

    await db
      .insert(settings)
      .values(insertPayload)
      .onConflictDoUpdate({
        target: [settings.tenantId, settings.key],
        set: updatePayload,
      })

    await this.eventEmitter.emit('setting.updated', { tenantId, key, value })
  }

  async setMany(entries: readonly SettingEntryInput[]): Promise<void> {
    for (const entry of entries) {
      await this.set(entry.key, entry.value, entry.options ?? {})
    }
  }

  async delete(key: string, options?: SettingOption): Promise<void> {
    const tenantId = this.resolveTenantId(options)
    const db = this.dbAccessor.get()
    await db.delete(settings).where(and(eq(settings.tenantId, tenantId), eq(settings.key, key)))

    await this.eventEmitter.emit('setting.deleted', { tenantId, key })
  }

  async deleteMany(keys: readonly string[], options?: SettingOption): Promise<void> {
    if (keys.length === 0) {
      return
    }

    const tenantId = this.resolveTenantId(options)
    const db = this.dbAccessor.get()
    const uniqueKeys = Array.from(new Set(keys))
    await db
      .delete(settings)
      .where(and(eq(settings.tenantId, tenantId), inArray(settings.key, uniqueKeys)))

    for (const key of uniqueKeys) {
      await this.eventEmitter.emit('setting.deleted', { tenantId, key })
    }
  }

  async getUiSchema(): Promise<SettingUiSchemaResponse> {
    const rawValues = await this.getMany(SETTING_UI_SCHEMA_KEYS, {})
    const typedValues: SettingUiSchemaResponse['values'] = {}

    for (const key of SETTING_UI_SCHEMA_KEYS) {
      const metadata = DEFAULT_SETTING_METADATA[key]
      const rawValue = rawValues[key] ?? null

      if (metadata?.isSensitive) {
        typedValues[key] = null
        continue
      }

      typedValues[key] = rawValue as SettingValueMap[typeof key] | null
    }

    return {
      schema: SETTING_UI_SCHEMA,
      values: typedValues,
    }
  }

  private async findSettingRecord(key: string, tenantId: string): Promise<SettingRecord | null> {
    const db = this.dbAccessor.get()
    const [record] = await db
      .select()
      .from(settings)
      .where(and(eq(settings.tenantId, tenantId), eq(settings.key, key)))
      .limit(1)

    return record ?? null
  }

  private resolveTenantId(options?: SettingOption): string {
    if (options?.tenantId) {
      return options.tenantId
    }

    const tenant = getTenantContext()
    if (!tenant) {
      throw new BizException(ErrorCode.TENANT_NOT_FOUND)
    }

    return tenant.tenant.id
  }

  private encrypt(value: string): string {
    const iv = randomBytes(IV_LENGTH)
    const cipher = createCipheriv(AES_ALGORITHM, this.encryptionKey, iv)
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const authTag = cipher.getAuthTag()
    return Buffer.concat([iv, authTag, encrypted]).toString('base64')
  }

  private decrypt(payload: string): string {
    const buffer = Buffer.from(payload, 'base64')
    const iv = buffer.subarray(0, IV_LENGTH)
    const authTag = buffer.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
    const encryptedText = buffer.subarray(IV_LENGTH + AUTH_TAG_LENGTH)
    const decipher = createDecipheriv(AES_ALGORITHM, this.encryptionKey, iv)
    decipher.setAuthTag(authTag)
    const decrypted = Buffer.concat([decipher.update(encryptedText), decipher.final()])
    return decrypted.toString('utf8')
  }
}
