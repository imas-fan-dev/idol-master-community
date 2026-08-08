# 数据库架构

当前工作树的 PostgreSQL 分层 ER 图与完整物理表清单见
[PostgreSQL 表关系图](database-table-relationships.md)。

## 当前结论

IMSWeb 采用一个 PostgreSQL 物理数据库和一个进程级连接池。Core 与 Story 仅是业务能力边界，
共享底层连接与版本化 schema：

```text
Hono domains -> repository ports <- SQL repositories
                                      |
                                 SQL driver port
                                      |
                             PostgreSQL connection pool
```

活动运行时、测试与运维命令使用同一 PostgreSQL 语义。应用启动不执行 DDL；
`migrations/postgresql/` 是结构演进的唯一来源。

## 依赖方向

- `src/ports/repositories.ts` 定义业务仓储契约。
- `src/infra/db/repositories/` 实现可复用 SQL Repository。
- `src/infra/db/sql/` 定义内部 statement、batch 和 transaction 契约。
- `src/infra/db/postgresql/` 封装连接池、参数转换和 schema 验证。
- `src/runtime/node-services.ts` 是唯一组合根，创建一个连接并注入各业务端口。

Domain 与 middleware 不得导入具体数据库模块。Repository 不读取环境变量，也不拥有连接池
配置；运行时组合根负责生命周期。

## 事务与并发

`ManagedSqlDatabase.transaction()` 为多语句业务操作提供同一连接上的显式事务。乐观锁写入必须
把前置变更和最终 revision guard 放在同一事务中；guard 失败时抛出内部冲突标记触发回滚，
事务外再读取当前 revision 形成稳定的 409 响应。

`batch()` 适合无条件的一组原子 SQL；需要根据中间结果决定提交或回滚时使用 `transaction()`。
测试必须连接真实 PostgreSQL，并覆盖冲突后的数据回读，不能只断言返回值。

## 连接与性能

连接池具有建连、空闲、语句和空闲事务超时。普通读取直接使用 pool query，只有 batch 或显式
transaction 才占用专用连接。分页使用稳定的 BIGINT 游标与有界 `ORDER BY id DESC LIMIT`，避免
大偏移扫描。

每个 API 进程的默认池上限是 10。部署扩容前需按进程数计算总连接预算，并通过 PostgreSQL
慢查询、锁等待和连接使用率确认容量，而不是只调整池上限。

## Schema 与发布门禁

迁移器通过 advisory lock、事务和 SHA-256 记录保证幂等执行。发布流程必须：

1. 备份 PostgreSQL 与对象存储，并记录同一发布标识。
2. 对目标数据库运行 `pnpm run migration:postgresql`。
3. 启动新 API，验证 `/api/health/live` 与 `/api/health/ready`。
4. 验证代表性公开读取、认证、管理写入和冲突回滚。
5. 观察结构化请求日志、数据库错误、连接数、延迟和 5xx 后再完成切流。

回滚应用版本前必须确认旧版本理解当前 schema。破坏性结构清理应拆成后续发布，不能与依赖它的
应用变更在同一次不可逆操作中完成。
