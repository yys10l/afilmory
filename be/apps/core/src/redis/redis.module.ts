import { Module } from '@afilmory/framework'
import { injectable } from 'tsyringe'

import { RedisConfig } from './redis.config'
import { RedisAccessor, RedisProvider } from './redis.provider'

@injectable()
class RedisTokenProvider {
  constructor(private readonly provider: RedisProvider) {}
  get() {
    return this.provider.getClient()
  }
}

@Module({
  providers: [RedisConfig, RedisProvider, RedisAccessor, RedisTokenProvider],
})
export class RedisModule {}
