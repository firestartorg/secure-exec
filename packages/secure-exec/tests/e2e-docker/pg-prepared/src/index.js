const { Client } = require("pg");

async function main() {
	const client = new Client({
		host: process.env.PG_HOST,
		port: Number(process.env.PG_PORT),
		user: "testuser",
		password: "testpass",
		database: "testdb",
	});

	await client.connect();

	// Setup table
	await client.query(
		"CREATE TABLE IF NOT EXISTS test_prepared (id SERIAL PRIMARY KEY, value TEXT, num INTEGER)",
	);

	// Named prepared statement: insert
	await client.query({
		name: "insert-row",
		text: "INSERT INTO test_prepared (value, num) VALUES ($1, $2)",
		values: ["alpha", 1],
	});

	// Reuse same named prepared statement (exercises prepared statement cache)
	await client.query({
		name: "insert-row",
		text: "INSERT INTO test_prepared (value, num) VALUES ($1, $2)",
		values: ["beta", 2],
	});

	await client.query({
		name: "insert-row",
		text: "INSERT INTO test_prepared (value, num) VALUES ($1, $2)",
		values: ["gamma", 3],
	});

	// Named prepared statement: select
	const res1 = await client.query({
		name: "select-by-value",
		text: "SELECT id, value, num FROM test_prepared WHERE value = $1",
		values: ["beta"],
	});

	// Reuse named select
	const res2 = await client.query({
		name: "select-by-value",
		text: "SELECT id, value, num FROM test_prepared WHERE value = $1",
		values: ["gamma"],
	});

	// Named prepared statement: select all ordered
	const resAll = await client.query({
		name: "select-all-ordered",
		text: "SELECT value, num FROM test_prepared ORDER BY num ASC",
		values: [],
	});

	// Named prepared statement: update
	await client.query({
		name: "update-num",
		text: "UPDATE test_prepared SET num = $1 WHERE value = $2",
		values: [99, "alpha"],
	});

	// Reuse named select to verify update
	const resUpdated = await client.query({
		name: "select-by-value",
		text: "SELECT id, value, num FROM test_prepared WHERE value = $1",
		values: ["alpha"],
	});

	// Named prepared statement: delete
	await client.query({
		name: "delete-by-value",
		text: "DELETE FROM test_prepared WHERE value = $1",
		values: ["gamma"],
	});

	// Verify deletion with reused select-all
	const resAfterDelete = await client.query({
		name: "select-all-ordered",
		text: "SELECT value, num FROM test_prepared ORDER BY num ASC",
		values: [],
	});

	// Cleanup
	await client.query("DROP TABLE test_prepared");
	await client.end();

	console.log(
		JSON.stringify({
			inserted: 3,
			selectBeta: { rowCount: res1.rowCount, value: res1.rows[0].value, num: res1.rows[0].num },
			selectGamma: { rowCount: res2.rowCount, value: res2.rows[0].value, num: res2.rows[0].num },
			selectAll: resAll.rows.map((r) => ({ value: r.value, num: r.num })),
			updated: { value: resUpdated.rows[0].value, num: resUpdated.rows[0].num },
			afterDelete: resAfterDelete.rows.map((r) => ({ value: r.value, num: r.num })),
		}),
	);
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
