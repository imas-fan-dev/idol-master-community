export interface SqlResultMeta {
    changes: number;
    last_row_id?: number;
    [key: string]: unknown;
}

export interface SqlResult<Row = Record<string, unknown>> {
    results: Row[];
    success: boolean;
    meta: SqlResultMeta;
}

export interface SqlStatement {
    bind(...values: unknown[]): SqlStatement;
    first<Value = Record<string, unknown>>(column?: string): Promise<Value | null>;
    all<Row = Record<string, unknown>>(): Promise<SqlResult<Row>>;
    run<Row = Record<string, unknown>>(): Promise<SqlResult<Row>>;
}

export interface SqlDatabase {
    prepare(sql: string): SqlStatement;
    batch<Row = Record<string, unknown>>(statements: SqlStatement[]): Promise<SqlResult<Row>[]>;
}

export interface ManagedSqlDatabase extends SqlDatabase {
    executeScript(sql: string): Promise<void>;
    transaction<Value>(operation: (database: SqlDatabase) => Promise<Value>): Promise<Value>;
    close(): Promise<void>;
}

export interface SqlSchemaStrategy {
    initializeCore(database: ManagedSqlDatabase): Promise<void>;
    initializePlatform(database: ManagedSqlDatabase): Promise<void>;
    initializeFudaba(database: ManagedSqlDatabase): Promise<void>;
    initializeStory(database: ManagedSqlDatabase): Promise<void>;
}
