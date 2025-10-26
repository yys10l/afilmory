import { generateId } from '@afilmory/be-utils'
import { authAccounts, authSessions, authUsers } from '@afilmory/db'
import type { OnModuleInit } from '@afilmory/framework'
import { HttpContext, createLogger } from '@afilmory/framework'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin } from 'better-auth/plugins'
import type { Context } from 'hono'
import { injectable } from 'tsyringe'

import { DrizzleProvider } from '../../database/database.provider'
import { AuthConfig } from './auth.config'

export type BetterAuthInstance = ReturnType<typeof betterAuth>

const logger = createLogger('Auth')

@injectable()
export class AuthProvider implements OnModuleInit {
  private instance?: ReturnType<typeof this.createAuth>

  constructor(
    private readonly config: AuthConfig,
    private readonly drizzleProvider: DrizzleProvider,
  ) {}

  onModuleInit(): void {
    this.instance = this.getAuth()
  }

  private createAuth() {
    const options = this.config.getOptions()
    const db = this.drizzleProvider.getDb()
    return betterAuth({
      database: drizzleAdapter(db, {
        provider: 'pg',
        schema: {
          user: authUsers,
          session: authSessions,
          account: authAccounts,
        },
      }),
      socialProviders: options.socialProviders,
      emailAndPassword: { enabled: true },
      user: {
        // Ensure tenantId and role are part of the typed/session payload
        additionalFields: {
          tenantId: { type: 'string', input: false },
          role: { type: 'string', input: false },
        },
      },
      databaseHooks: {
        session: {
          create: {
            before: async (session) => {
              // Attach tenantId from our request-scoped context to the auth session record
              const tenant = HttpContext.getValue('tenant') as { tenant: { id: string } } | undefined
              return {
                data: {
                  ...session,
                  tenantId: tenant?.tenant.id ?? null,
                },
              }
            },
          },
        },
      },
      advanced: {
        database: {
          generateId: () => generateId(),
        },
      },
      plugins: [
        admin({
          adminRoles: ['admin'],
          defaultRole: 'user',
          defaultBanReason: 'Spamming',
        }),
      ],
    })
  }
  getAuth() {
    if (!this.instance) {
      this.instance = this.createAuth()
      logger.info('Better Auth initialized')
    }
    return this.instance
  }

  handler(context: Context): Promise<Response> {
    const auth = this.getAuth()
    return auth.handler(context.req.raw)
  }
}

export type AuthInstance = ReturnType<AuthProvider['createAuth']>
export type AuthSession = BetterAuthInstance['$Infer']['Session']
