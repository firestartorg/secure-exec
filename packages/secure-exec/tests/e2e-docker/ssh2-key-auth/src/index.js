const { Client } = require("ssh2");
const fs = require("fs");
const path = require("path");

async function main() {
	const privateKey = fs.readFileSync(
		path.join(__dirname, "..", "keys", "test_rsa"),
	);

	const result = await new Promise((resolve, reject) => {
		const conn = new Client();

		conn.on("ready", () => {
			conn.exec("echo hello-from-key-auth && whoami", (err, stream) => {
				if (err) return reject(err);

				let stdout = "";
				let stderr = "";

				stream.on("data", (data) => {
					stdout += data.toString();
				});
				stream.stderr.on("data", (data) => {
					stderr += data.toString();
				});
				stream.on("close", (code) => {
					conn.end();
					resolve({
						connected: true,
						authMethod: "publickey",
						code,
						stdout: stdout.trim(),
						stderr: stderr.trim(),
					});
				});
			});
		});

		conn.on("error", reject);

		conn.connect({
			host: process.env.SSH_HOST,
			port: Number(process.env.SSH_PORT),
			username: "testuser",
			privateKey,
		});
	});

	console.log(JSON.stringify(result));
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
