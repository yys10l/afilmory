# PR #1：S3/R2 URL 与签名审查

审查日期：2026-10-22（Asia/Shanghai）。基线为 `yys10l/afilmory` 的 main 提交
`709c264b188b80d5850be1d56bd5eeebbfafc4b6`。不使用真实密钥、不请求真实存储服务。

## 结论

[PR #1](https://github.com/yys10l/afilmory/pull/1) 的 `forcePathStyle: true` 补丁已经不适用于当前实现：
当前没有 AWS SDK S3ClientConfig，普通自定义 endpoint 使用路径形式。原 DNS 拼接场景的匿名模拟
`bucket=yys, endpoint=https://gallery.example.invalid` 在未修改主分支上已经生成
`https://gallery.example.invalid/yys/album/a.jpg`，不会生成 `yys.gallery.example.invalid`。

这仅证明旧的 URL 子域名拼接原因已被替代，不证明真实 R2 连接成功。若原 endpoint 是 R2 的公开域名，
仍需改为账户级 S3 API endpoint；公开域名放在 customDomain。自建代理是否实现 S3 API 需要单独确认。

建议以本补丁独立审查替代旧实现的移植；PR #1 可标记为已被客户端重构及本修复取代后关闭，不应冲突合并。
本次没有合并、关闭或修改 PR #1，也没有更改 main。

## 可复现发现与最小修正

| 位置/问题                                  | 主分支复现                                                                                              | 修正                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `buildBaseUrl` 的 `includes(bucket)`       | Bucket `abc` 出现在 R2 账户 `012abc345` 内时，生成账户根地址，漏掉 `/abc/`；Bucket `https` 甚至匹配协议 | 解析 URL；匹配完整主机前缀或末尾路径段；排除标准账户/服务主机            |
| 服务名称的宽泛字符串匹配                   | 普通主机的 `/aliyuncs.com` 路径会触发 Bucket 子域名注入，可能再次产生错误主机                           | 仅检查真实 hostname 的域名后缀                                           |
| 占位符、末尾斜杠和编码路径                 | 多个 `{bucket}` 只替换一个；多余末尾斜杠保留；`/%70hotos` 未识别为已有 Bucket                           | 完整替换、基地址尾部归一、解码末尾路径段后匹配                           |
| 列表 prefix 二次编码                       | 原始 `秋 日/#?+%/` 在服务端一次查询解码后仍是百分号编码文本，会筛选错误前缀                             | 原始 prefix 交给 URLSearchParams 编码                                    |
| customDomain 未编码 key                    | `a#b?c+d.jpg` 中的 `#` 变成片段；字面量 `%2F`、反斜杠等可能改变对象路径                                 | 复用按段 RFC 3986 编码；不加 Bucket 或重复 prefix                        |
| SigV4 查询编码/排序                        | `!'()*` 未转义；localeCompare 对大小写及符号排序与编码后 ASCII 次序不同                                 | RFC 3986 编码，编码后的查询键/值按 ASCII 次序排序；规范头也用 ASCII 排序 |
| 请求路径与规范路径                         | URL 构造保留 `!'()*`，签名却将它们转义                                                                  | URL 构造与签名传输共用同一编码路径，保留重复斜杠及字面量百分号           |
| 独立点路径段                               | `a/../b.jpg` 被 WHATWG URL/fetch 折叠为另一个 key；签名本身可能正确却操作错误对象                       | 在生成 URL 前明确拒绝独立 `.`/`..` 段；不是宣称支持这些 key              |
| endpoint/customDomain 查询、片段或内嵌凭据 | 字符串追加的 Bucket/key 可能落进查询或片段；配置错误延后暴露                                            | 要求绝对 HTTP(S) 基地址，无查询、片段、内嵌凭据                          |
| AWS 默认地址边界                           | 含点 Bucket 使用不被标准通配证书覆盖的主机；中国区域仍拼 `.com`                                         | 含点 Bucket 默认使用路径形式；`cn-` 区域使用 `.com.cn`                   |
| 临时凭据                                   | 配置的 sessionToken 被忽略                                                                              | 传递并签入 `x-amz-security-token`                                        |

运行时代码只修改三个现有文件：`src/s3/client.ts`、`src/storage/providers/s3-client.ts`、
`src/storage/providers/s3-provider.ts`（均在 packages/builder 下）。没有恢复 AWS SDK，没有增加运行时依赖或配置开关。
另增加测试脚本、测试文件与配置说明。

## URL 规则与兼容性

| 场景                                             | 修正后的规则                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| AWS 默认普通 Bucket                              | `https://bucket.s3.region.amazonaws.com/key`                              |
| AWS 默认含点 Bucket                              | `https://s3.region.amazonaws.com/bucket/key`                              |
| AWS 显式 regional/global/dualstack/中国 endpoint | 保留主机，默认 `/bucket/key`；已有 Bucket 主机或末尾路径不重复添加        |
| R2 标准账户及 eu/fedramp 账户 endpoint           | 保留账户主机，添加 `/bucket/key`，签名区域按配置（推荐 auto）             |
| R2 已带 Bucket 的主机或路径                      | 不重复添加 Bucket；只验证地址生成，不保证所有 R2 托管形式都支持该访问模式 |
| 自建 S3/MinIO、带端口、IPv6、代理路径            | 保留主机、端口和路径前缀，添加 Bucket；复杂路径可用 `{bucket}` 指定       |
| OSS/COS                                          | 保留原有默认/显式域名规则；此处只做 URL 回归保护，未验证服务端鉴权        |
| customDomain/CDN                                 | 公开基地址 + 编码后的完整 key；不参与 API 请求目标或签名                  |

通用代理无法只凭字符串判断“同名路径是代理前缀还是 Bucket”。沿用并收紧兼容规则：完整 Bucket 主机前缀或末尾路径表示已含 Bucket。
如果语义不同，可用现有 `{bucket}` 模板明确 URL，而不是继续依赖子串猜测。
本补丁覆盖常规 S3 Bucket API，不声称实现 Access Point ARN、S3 Express、自动区域重定向或所有特殊端点的完整解析器。

## 旧 PR 改动的回归风险

1. `forcePathStyle` 属于已经移除的 SDK 配置，直接移植没有可作用的对象。
2. 旧 PR 对 `r2.cloudflarestorage.com` 直接返回 `endpoint/key`。账户级 endpoint 不包含 Bucket，这会删除必需的 `/bucket/`。
3. 旧 PR 对其他自定义 endpoint 也改为 `endpoint/key`，会破坏普通 MinIO、自建 S3 及带代理前缀的路径规则。
4. 旧 PR 的 AWS 特判会重新按 region 拼主机，覆盖显式端点；整体移植会丢失当前 `buildObjectUrl` 的路径编码并再次产生两套规则。
5. 旧 customDomain 分支直接拼原始 key，无法修复特殊字符问题。builder 默认配置中的注释改动与本问题无关，不移植。

## 测试与复验

环境：Node.js 24.19.0、tsx 4.21.0、TypeScript 5.9.3；运行时依赖使用仓库声明的
fast-xml-parser 5.3.2 和 consola 3.4.2。没有加载项目 env 或 builder 配置。

同一套 72 个用例在独立工作目录对比：

| 被测版本                | 通过 | 失败 |
| ----------------------- | ---: | ---: |
| 未修改 main（上述 SHA） |   29 |   43 |
| 当前修复                |   72 |    0 |

失败数是用例数，不是独立缺陷数；其中也包含新增的配置拒绝策略和点路径段保护要求。
旧 DNS 场景以及 AWS 官方的 4 个固定签名样例在 main 上已通过；不能把这些归功于新补丁。

测试包括端点矩阵、UTF-8/空格/`#?+%!'()*`/反斜杠/连续斜杠/字面量 `%2F`、
原始 prefix、重复查询参数、空查询值、header 顺序、临时 token、GET/HEAD/PUT/DELETE/COPY。
独立签名校验器不调用生产编码或签名函数，并与 AWS 固定样例交叉核对。
本机 HTTP 服务测试使用真正的 fetch，按服务器收到的 Host（含端口）、路径、查询和 body 复算签名。
测试中的 DELETE/COPY 只调用 mock，不会操作真实对象；本机服务也不连接云端。

安装项目依赖后运行：

```bash
pnpm --filter @afilmory/builder test:s3
```

本环境的 pnpm 11 在运行前尝试安装整个 workspace，因 `ERR_PNPM_IGNORED_BUILDS` 未完成；
没有批准或执行这些无关的构建脚本。已使用 `npm --prefix packages/builder run test:s3` 验证同一测试脚本。
直接命令及本次通过的定向类型检查：

```bash
node --import tsx --test --test-reporter=tap packages/builder/tests/s3.test.ts
node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target ESNext --module ESNext --moduleResolution bundler --allowSyntheticDefaultImports packages/builder/tests/s3.test.ts
git diff --check
```

未执行整个前后端构建或 manifest 生成。本次结论限定为代码规则、协议样例和本地传输一致性；没有验证真实 DNS、TLS、
R2/AWS 凭据权限、Bucket 策略、代理行为或生产服务返回。上线前仍需在正确 API endpoint 上进行受控 ListObjectsV2/GetObject 验证。

## 依据

- [原 PR 的实现与目标](https://github.com/yys10l/afilmory/pull/1)
- [固定基线 S3 客户端](https://github.com/yys10l/afilmory/blob/709c264b188b80d5850be1d56bd5eeebbfafc4b6/packages/builder/src/s3/client.ts)
- [固定基线存储提供者](https://github.com/yys10l/afilmory/blob/709c264b188b80d5850be1d56bd5eeebbfafc4b6/packages/builder/src/storage/providers/s3-provider.ts)
- [Cloudflare R2 S3 API 与区域](https://developers.cloudflare.com/r2/api/s3/api/)
- [Cloudflare R2 公开域名与不支持根目录列举的说明](https://developers.cloudflare.com/r2/buckets/public-buckets/)
- [AWS SigV4 编码、路径规则与固定签名样例](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html)
- [AWS S3 虚拟主机、路径形式及含点 Bucket 的 TLS 限制](https://docs.aws.amazon.com/AmazonS3/latest/userguide/VirtualHosting.html)
- [AWS 中国区域域名](https://docs.amazonaws.cn/en_us/general/latest/gr/endpoints-arns.html)
