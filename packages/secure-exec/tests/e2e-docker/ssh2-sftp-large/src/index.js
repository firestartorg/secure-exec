const { createHash } = require("crypto");
const { Client } = require("ssh2");

// Generate deterministic 1MB payload
function generatePayload(size) {
	const buf = Buffer.alloc(size);
	for (let i = 0; i < size; i++) {
		buf[i] = i & 0xff;
	}
	return buf;
}

function hashBuffer(buf) {
	return createHash("sha256").update(buf).digest("hex");
}

async function main() {
	const PAYLOAD_SIZE = 1024 * 1024; // 1MB
	const payload = generatePayload(PAYLOAD_SIZE);
	const uploadHash = hashBuffer(payload);

	const result = await new Promise((resolve, reject) => {
		const conn = new Client();

		conn.on("ready", () => {
			conn.sftp((err, sftp) => {
				if (err) return reject(err);

				const uploadPath = "/home/testuser/upload/large-test.bin";
				const renamedPath = "/home/testuser/upload/large-renamed.bin";

				// Upload via createWriteStream
				const ws = sftp.createWriteStream(uploadPath);
				ws.on("error", reject);
				ws.end(payload, () => {
					// Stat uploaded file
					sftp.stat(uploadPath, (err, uploadStats) => {
						if (err) return reject(err);

						// Rename the file
						sftp.rename(uploadPath, renamedPath, (err) => {
							if (err) return reject(err);

							// Download via createReadStream
							const rs = sftp.createReadStream(renamedPath);
							const chunks = [];
							rs.on("data", (chunk) => chunks.push(chunk));
							rs.on("error", reject);
							rs.on("end", () => {
								const downloaded = Buffer.concat(chunks);
								const downloadHash = hashBuffer(downloaded);

								// Cleanup
								sftp.unlink(renamedPath, (err) => {
									conn.end();
									if (err) return reject(err);
									resolve({
										uploadSize: PAYLOAD_SIZE,
										uploadHash,
										statSize: uploadStats.size,
										downloadSize: downloaded.length,
										downloadHash,
										hashMatch: uploadHash === downloadHash,
										renamed: true,
									});
								});
							});
						});
					});
				});
			});
		});

		conn.on("error", reject);

		conn.connect({
			host: process.env.SSH_HOST,
			port: Number(process.env.SSH_PORT),
			username: "testuser",
			password: "testpass",
		});
	});

	console.log(JSON.stringify(result));
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
