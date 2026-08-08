const bcrypt = require('bcrypt');
const { Pool } = require('pg');

function databaseUrl(environment = process.env) {
    const value = environment.DATABASE_URL?.trim();
    if (!value) throw new Error('DATABASE_URL is required for PostgreSQL');
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
    }
    if (
        !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
        !parsed.hostname ||
        parsed.pathname === '/'
    ) {
        throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
    }
    return value;
}

async function addUser({
    environment = process.env,
    PoolClass = Pool,
    hashPassword = bcrypt.hash,
    logger = console
} = {}) {
    const username = environment.IMS_NEW_USER_USERNAME;
    const password = environment.IMS_NEW_USER_PASSWORD;
    const dept = environment.IMS_NEW_USER_DEPT || 'editor';
    const producername = environment.IMS_NEW_USER_PRODUCER_NAME;

    if (!username || !password || !producername) {
        throw new Error(
            'Set IMS_NEW_USER_USERNAME, IMS_NEW_USER_PASSWORD, and IMS_NEW_USER_PRODUCER_NAME.'
        );
    }
    if (!['editor', 'op'].includes(dept)) {
        throw new Error('IMS_NEW_USER_DEPT must be either editor or op.');
    }

    const connectionString = databaseUrl(environment);
    const pool = new PoolClass({
        connectionString,
        application_name: 'imsweb-ops-add-user'
    });
    try {
        const hashed = await hashPassword(password, 12);
        const result = await pool.query(
            `INSERT INTO backoffice_accounts
                (username, password, dept, producername, admin_role)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (username) DO NOTHING
             RETURNING id`,
            [username, hashed, dept, producername, dept === 'op' ? 'admin' : null]
        );
        if (result.rowCount === 0) {
            logger.error(`Username ${username} already exists.`);
            return { created: false, id: null };
        }

        const id = result.rows[0].id;
        logger.log(`User created with ID ${id}.`);
        return { created: true, id };
    } finally {
        await pool.end();
    }
}

if (require.main === module) {
    addUser()
        .then(({ created }) => {
            if (!created) process.exitCode = 1;
        })
        .catch((err) => {
            console.error(err.message);
            process.exitCode = 1;
        });
}

module.exports = { addUser, databaseUrl };
