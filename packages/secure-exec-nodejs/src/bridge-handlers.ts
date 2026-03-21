// Build a BridgeHandlers map for V8 runtime.
//
// Each handler is a plain function that performs the host-side operation.
// Handler names match HOST_BRIDGE_GLOBAL_KEYS from the bridge contract.

import * as net from "node:net";
import * as tls from "node:tls";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
	randomFillSync,
	randomUUID,
	createHash,
	createHmac,
	pbkdf2Sync,
	scryptSync,
	hkdfSync,
	createCipheriv,
	createDecipheriv,
	sign,
	verify,
	generateKeyPairSync,
	createPrivateKey,
	createPublicKey,
	timingSafeEqual,
	type Cipher,
	type Decipher,
} from "node:crypto";
import {
	HOST_BRIDGE_GLOBAL_KEYS,
} from "./bridge-contract.js";
import {
	mkdir,
} from "@secure-exec/core";
import { normalizeBuiltinSpecifier } from "./builtin-modules.js";
import { resolveModule, loadFile } from "./package-bundler.js";
import { transformDynamicImport } from "@secure-exec/core/internal/shared/esm-utils";
import { bundlePolyfill, hasPolyfill } from "./polyfills.js";
import {
	checkBridgeBudget,
	assertPayloadByteLength,
	assertTextPayloadSize,
	getBase64EncodedByteLength,
	parseJsonWithLimit,
	polyfillCodeCache,
	RESOURCE_BUDGET_ERROR_CODE,
} from "./isolate-bootstrap.js";
import type {
	CommandExecutor,
	NetworkAdapter,
	SpawnedProcess,
} from "@secure-exec/core";
import type { VirtualFileSystem } from "@secure-exec/core";
import type { ResolutionCache } from "./package-bundler.js";
import type {
	StdioEvent,
	StdioHook,
	ProcessConfig,
} from "@secure-exec/core/internal/shared/api-types";
import type { BudgetState } from "./isolate-bootstrap.js";

/** A bridge handler function invoked when sandbox code calls a bridge global. */
export type BridgeHandler = (...args: unknown[]) => unknown | Promise<unknown>;

/** Map of bridge global names to their handler functions. */
export type BridgeHandlers = Record<string, BridgeHandler>;

/** Result of building crypto bridge handlers — includes dispose for session cleanup. */
export interface CryptoBridgeResult {
	handlers: BridgeHandlers;
	dispose: () => void;
}

/** Stateful cipher/decipher session stored between bridge calls. */
interface CipherSession {
	cipher: Cipher | Decipher;
	algorithm: string;
}

/**
 * Build crypto bridge handlers.
 *
 * All handler functions are plain functions (no ivm.Reference wrapping).
 * The V8 runtime registers these by name on the V8 global.
 * Call dispose() when the execution ends to clear stateful cipher sessions.
 */
export function buildCryptoBridgeHandlers(): CryptoBridgeResult {
	const handlers: BridgeHandlers = {};
	const K = HOST_BRIDGE_GLOBAL_KEYS;

	// Stateful cipher sessions — tracks cipher/decipher instances between
	// create/update/final bridge calls (needed for ssh2 streaming AES-GCM).
	const cipherSessions = new Map<number, CipherSession>();
	let nextCipherSessionId = 1;

	// Secure randomness — cap matches Web Crypto API spec (65536 bytes).
	handlers[K.cryptoRandomFill] = (byteLength: unknown) => {
		const len = Number(byteLength);
		if (len > 65536) {
			throw new RangeError(
				`The ArrayBufferView's byte length (${len}) exceeds the number of bytes of entropy available via this API (65536)`,
			);
		}
		const buffer = Buffer.allocUnsafe(len);
		randomFillSync(buffer);
		return buffer.toString("base64");
	};
	handlers[K.cryptoRandomUuid] = () => randomUUID();

	// createHash — guest accumulates update() data, sends base64 to host for digest.
	handlers[K.cryptoHashDigest] = (algorithm: unknown, dataBase64: unknown) => {
		const data = Buffer.from(String(dataBase64), "base64");
		const hash = createHash(String(algorithm));
		hash.update(data);
		return hash.digest("base64");
	};

	// createHmac — guest accumulates update() data, sends base64 to host for HMAC digest.
	handlers[K.cryptoHmacDigest] = (algorithm: unknown, keyBase64: unknown, dataBase64: unknown) => {
		const key = Buffer.from(String(keyBase64), "base64");
		const data = Buffer.from(String(dataBase64), "base64");
		const hmac = createHmac(String(algorithm), key);
		hmac.update(data);
		return hmac.digest("base64");
	};

	// pbkdf2Sync — derive key from password + salt.
	handlers[K.cryptoPbkdf2] = (
		passwordBase64: unknown,
		saltBase64: unknown,
		iterations: unknown,
		keylen: unknown,
		digest: unknown,
	) => {
		const password = Buffer.from(String(passwordBase64), "base64");
		const salt = Buffer.from(String(saltBase64), "base64");
		return pbkdf2Sync(
			password,
			salt,
			Number(iterations),
			Number(keylen),
			String(digest),
		).toString("base64");
	};

	// scryptSync — derive key from password + salt with tunable cost params.
	handlers[K.cryptoScrypt] = (
		passwordBase64: unknown,
		saltBase64: unknown,
		keylen: unknown,
		optionsJson: unknown,
	) => {
		const password = Buffer.from(String(passwordBase64), "base64");
		const salt = Buffer.from(String(saltBase64), "base64");
		const options = JSON.parse(String(optionsJson));
		return scryptSync(password, salt, Number(keylen), options).toString(
			"base64",
		);
	};

	// createCipheriv — guest accumulates update() data, sends base64 to host for encryption.
	// Returns JSON with data (and authTag for GCM modes).
	handlers[K.cryptoCipheriv] = (
		algorithm: unknown,
		keyBase64: unknown,
		ivBase64: unknown,
		dataBase64: unknown,
	) => {
		const key = Buffer.from(String(keyBase64), "base64");
		const iv = Buffer.from(String(ivBase64), "base64");
		const data = Buffer.from(String(dataBase64), "base64");
		const cipher = createCipheriv(String(algorithm), key, iv) as any;
		const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
		const isGcm = String(algorithm).includes("-gcm");
		if (isGcm) {
			return JSON.stringify({
				data: encrypted.toString("base64"),
				authTag: cipher.getAuthTag().toString("base64"),
			});
		}
		return JSON.stringify({ data: encrypted.toString("base64") });
	};

	// createDecipheriv — guest accumulates update() data, sends base64 to host for decryption.
	// Accepts optionsJson with authTag for GCM modes.
	handlers[K.cryptoDecipheriv] = (
		algorithm: unknown,
		keyBase64: unknown,
		ivBase64: unknown,
		dataBase64: unknown,
		optionsJson: unknown,
	) => {
		const key = Buffer.from(String(keyBase64), "base64");
		const iv = Buffer.from(String(ivBase64), "base64");
		const data = Buffer.from(String(dataBase64), "base64");
		const options = JSON.parse(String(optionsJson));
		const decipher = createDecipheriv(String(algorithm), key, iv) as any;
		const isGcm = String(algorithm).includes("-gcm");
		if (isGcm && options.authTag) {
			decipher.setAuthTag(Buffer.from(options.authTag, "base64"));
		}
		return Buffer.concat([decipher.update(data), decipher.final()]).toString(
			"base64",
		);
	};

	// Stateful cipheriv create — opens a cipher or decipher session on the host.
	// mode: "cipher" | "decipher"; returns sessionId.
	handlers[K.cryptoCipherivCreate] = (
		mode: unknown,
		algorithm: unknown,
		keyBase64: unknown,
		ivBase64: unknown,
		optionsJson: unknown,
	) => {
		const algo = String(algorithm);
		const key = Buffer.from(String(keyBase64), "base64");
		const iv = Buffer.from(String(ivBase64), "base64");
		const options = optionsJson ? JSON.parse(String(optionsJson)) : {};
		const isGcm = algo.includes("-gcm");

		let instance: Cipher | Decipher;
		if (String(mode) === "decipher") {
			const d = createDecipheriv(algo, key, iv) as any;
			if (isGcm && options.authTag) {
				d.setAuthTag(Buffer.from(options.authTag, "base64"));
			}
			instance = d;
		} else {
			instance = createCipheriv(algo, key, iv) as any;
		}

		const sessionId = nextCipherSessionId++;
		cipherSessions.set(sessionId, { cipher: instance, algorithm: algo });
		return sessionId;
	};

	// Stateful cipheriv update — feeds data into an open session, returns partial result.
	handlers[K.cryptoCipherivUpdate] = (
		sessionId: unknown,
		dataBase64: unknown,
	) => {
		const id = Number(sessionId);
		const session = cipherSessions.get(id);
		if (!session) throw new Error(`Cipher session ${id} not found`);
		const data = Buffer.from(String(dataBase64), "base64");
		const result = session.cipher.update(data);
		return result.toString("base64");
	};

	// Stateful cipheriv final — finalizes session, returns last block + authTag for GCM.
	// Removes session from map.
	handlers[K.cryptoCipherivFinal] = (sessionId: unknown) => {
		const id = Number(sessionId);
		const session = cipherSessions.get(id);
		if (!session) throw new Error(`Cipher session ${id} not found`);
		cipherSessions.delete(id);
		const final = session.cipher.final();
		const isGcm = session.algorithm.includes("-gcm");
		if (isGcm) {
			const authTag = (session.cipher as any).getAuthTag?.();
			return JSON.stringify({
				data: final.toString("base64"),
				authTag: authTag ? authTag.toString("base64") : undefined,
			});
		}
		return JSON.stringify({ data: final.toString("base64") });
	};

	// sign — host signs data with a PEM private key.
	handlers[K.cryptoSign] = (
		algorithm: unknown,
		dataBase64: unknown,
		keyPem: unknown,
	) => {
		const data = Buffer.from(String(dataBase64), "base64");
		const key = createPrivateKey(String(keyPem));
		const signature = sign(String(algorithm) || null, data, key);
		return signature.toString("base64");
	};

	// verify — host verifies signature with a PEM public key.
	handlers[K.cryptoVerify] = (
		algorithm: unknown,
		dataBase64: unknown,
		keyPem: unknown,
		signatureBase64: unknown,
	) => {
		const data = Buffer.from(String(dataBase64), "base64");
		const key = createPublicKey(String(keyPem));
		const signature = Buffer.from(String(signatureBase64), "base64");
		return verify(String(algorithm) || null, data, key, signature);
	};

	// generateKeyPairSync — host generates key pair, returns PEM strings as JSON.
	handlers[K.cryptoGenerateKeyPairSync] = (
		type: unknown,
		optionsJson: unknown,
	) => {
		const options = JSON.parse(String(optionsJson));
		const genOptions = {
			...options,
			publicKeyEncoding: { type: "spki" as const, format: "pem" as const },
			privateKeyEncoding: { type: "pkcs8" as const, format: "pem" as const },
		};
		const { publicKey, privateKey } = generateKeyPairSync(
			type as any,
			genOptions as any,
		);
		return JSON.stringify({ publicKey, privateKey });
	};

	// crypto.subtle — single dispatcher for all Web Crypto API operations.
	// Guest-side SandboxSubtle serializes each call as JSON { op, ... }.
	handlers[K.cryptoSubtle] = (opJson: unknown) => {
		const req = JSON.parse(String(opJson));
		const normalizeHash = (h: string | { name: string }): string => {
			const n = typeof h === "string" ? h : h.name;
			return n.toLowerCase().replace("-", "");
		};
		switch (req.op) {
			case "digest": {
				const algo = normalizeHash(req.algorithm);
				const data = Buffer.from(req.data, "base64");
				return JSON.stringify({
					data: createHash(algo).update(data).digest("base64"),
				});
			}
			case "generateKey": {
				const algoName = req.algorithm.name;
				if (
					algoName === "AES-GCM" ||
					algoName === "AES-CBC" ||
					algoName === "AES-CTR"
				) {
					const keyBytes = Buffer.allocUnsafe(req.algorithm.length / 8);
					randomFillSync(keyBytes);
					return JSON.stringify({
						key: {
							type: "secret",
							algorithm: req.algorithm,
							extractable: req.extractable,
							usages: req.usages,
							_raw: keyBytes.toString("base64"),
						},
					});
				}
				if (algoName === "HMAC") {
					const hashName =
						typeof req.algorithm.hash === "string"
							? req.algorithm.hash
							: req.algorithm.hash.name;
					const hashLens: Record<string, number> = {
						"SHA-1": 20,
						"SHA-256": 32,
						"SHA-384": 48,
						"SHA-512": 64,
					};
					const len = req.algorithm.length
						? req.algorithm.length / 8
						: hashLens[hashName] || 32;
					const keyBytes = Buffer.allocUnsafe(len);
					randomFillSync(keyBytes);
					return JSON.stringify({
						key: {
							type: "secret",
							algorithm: req.algorithm,
							extractable: req.extractable,
							usages: req.usages,
							_raw: keyBytes.toString("base64"),
						},
					});
				}
				if (
					algoName === "RSASSA-PKCS1-v1_5" ||
					algoName === "RSA-OAEP" ||
					algoName === "RSA-PSS"
				) {
					let publicExponent = 65537;
					if (req.algorithm.publicExponent) {
						const expBytes = Buffer.from(
							req.algorithm.publicExponent,
							"base64",
						);
						publicExponent = 0;
						for (const b of expBytes) {
							publicExponent = (publicExponent << 8) | b;
						}
					}
					const { publicKey, privateKey } = generateKeyPairSync("rsa", {
						modulusLength: req.algorithm.modulusLength || 2048,
						publicExponent,
						publicKeyEncoding: {
							type: "spki" as const,
							format: "pem" as const,
						},
						privateKeyEncoding: {
							type: "pkcs8" as const,
							format: "pem" as const,
						},
					});
					return JSON.stringify({
						publicKey: {
							type: "public",
							algorithm: req.algorithm,
							extractable: req.extractable,
							usages: req.usages.filter((u: string) =>
								["verify", "encrypt", "wrapKey"].includes(u),
							),
							_pem: publicKey,
						},
						privateKey: {
							type: "private",
							algorithm: req.algorithm,
							extractable: req.extractable,
							usages: req.usages.filter((u: string) =>
								["sign", "decrypt", "unwrapKey"].includes(u),
							),
							_pem: privateKey,
						},
					});
				}
				throw new Error(`Unsupported key algorithm: ${algoName}`);
			}
			case "importKey": {
				const { format, keyData, algorithm, extractable, usages } = req;
				if (format === "raw") {
					return JSON.stringify({
						key: {
							type: "secret",
							algorithm,
							extractable,
							usages,
							_raw: keyData,
						},
					});
				}
				if (format === "jwk") {
					const jwk =
						typeof keyData === "string" ? JSON.parse(keyData) : keyData;
					if (jwk.kty === "oct") {
						const raw = Buffer.from(jwk.k, "base64url");
						return JSON.stringify({
							key: {
								type: "secret",
								algorithm,
								extractable,
								usages,
								_raw: raw.toString("base64"),
							},
						});
					}
					if (jwk.d) {
						const keyObj = createPrivateKey({ key: jwk, format: "jwk" });
						const pem = keyObj.export({
							type: "pkcs8",
							format: "pem",
						}) as string;
						return JSON.stringify({
							key: { type: "private", algorithm, extractable, usages, _pem: pem },
						});
					}
					const keyObj = createPublicKey({ key: jwk, format: "jwk" });
					const pem = keyObj.export({ type: "spki", format: "pem" }) as string;
					return JSON.stringify({
						key: { type: "public", algorithm, extractable, usages, _pem: pem },
					});
				}
				if (format === "pkcs8") {
					const keyBuf = Buffer.from(keyData, "base64");
					const keyObj = createPrivateKey({
						key: keyBuf,
						format: "der",
						type: "pkcs8",
					});
					const pem = keyObj.export({
						type: "pkcs8",
						format: "pem",
					}) as string;
					return JSON.stringify({
						key: { type: "private", algorithm, extractable, usages, _pem: pem },
					});
				}
				if (format === "spki") {
					const keyBuf = Buffer.from(keyData, "base64");
					const keyObj = createPublicKey({
						key: keyBuf,
						format: "der",
						type: "spki",
					});
					const pem = keyObj.export({ type: "spki", format: "pem" }) as string;
					return JSON.stringify({
						key: { type: "public", algorithm, extractable, usages, _pem: pem },
					});
				}
				throw new Error(`Unsupported import format: ${format}`);
			}
			case "exportKey": {
				const { format, key } = req;
				if (format === "raw") {
					if (!key._raw)
						throw new Error("Cannot export asymmetric key as raw");
					return JSON.stringify({
						data: key._raw,
					});
				}
				if (format === "jwk") {
					if (key._raw) {
						const raw = Buffer.from(key._raw, "base64");
						return JSON.stringify({
							jwk: {
								kty: "oct",
								k: raw.toString("base64url"),
								ext: key.extractable,
								key_ops: key.usages,
							},
						});
					}
					const keyObj =
						key.type === "private"
							? createPrivateKey(key._pem)
							: createPublicKey(key._pem);
					return JSON.stringify({
						jwk: keyObj.export({ format: "jwk" }),
					});
				}
				if (format === "pkcs8") {
					if (key.type !== "private")
						throw new Error("Cannot export non-private key as pkcs8");
					const keyObj = createPrivateKey(key._pem);
					const der = keyObj.export({
						type: "pkcs8",
						format: "der",
					}) as Buffer;
					return JSON.stringify({ data: der.toString("base64") });
				}
				if (format === "spki") {
					const keyObj =
						key.type === "private"
							? createPublicKey(createPrivateKey(key._pem))
							: createPublicKey(key._pem);
					const der = keyObj.export({
						type: "spki",
						format: "der",
					}) as Buffer;
					return JSON.stringify({ data: der.toString("base64") });
				}
				throw new Error(`Unsupported export format: ${format}`);
			}
			case "encrypt": {
				const { algorithm, key, data } = req;
				const rawKey = Buffer.from(key._raw, "base64");
				const plaintext = Buffer.from(data, "base64");
				const algoName = algorithm.name;
				if (algoName === "AES-GCM") {
					const iv = Buffer.from(algorithm.iv, "base64");
					const tagLength = (algorithm.tagLength || 128) / 8;
					const cipher = createCipheriv(
						`aes-${rawKey.length * 8}-gcm` as any,
						rawKey,
						iv,
						{ authTagLength: tagLength } as any,
					) as any;
					if (algorithm.additionalData) {
						cipher.setAAD(Buffer.from(algorithm.additionalData, "base64"));
					}
					const encrypted = Buffer.concat([
						cipher.update(plaintext),
						cipher.final(),
					]);
					const authTag = cipher.getAuthTag();
					return JSON.stringify({
						data: Buffer.concat([encrypted, authTag]).toString("base64"),
					});
				}
				if (algoName === "AES-CBC") {
					const iv = Buffer.from(algorithm.iv, "base64");
					const cipher = createCipheriv(
						`aes-${rawKey.length * 8}-cbc` as any,
						rawKey,
						iv,
					);
					const encrypted = Buffer.concat([
						cipher.update(plaintext),
						cipher.final(),
					]);
					return JSON.stringify({ data: encrypted.toString("base64") });
				}
				throw new Error(`Unsupported encrypt algorithm: ${algoName}`);
			}
			case "decrypt": {
				const { algorithm, key, data } = req;
				const rawKey = Buffer.from(key._raw, "base64");
				const ciphertext = Buffer.from(data, "base64");
				const algoName = algorithm.name;
				if (algoName === "AES-GCM") {
					const iv = Buffer.from(algorithm.iv, "base64");
					const tagLength = (algorithm.tagLength || 128) / 8;
					const encData = ciphertext.subarray(
						0,
						ciphertext.length - tagLength,
					);
					const authTag = ciphertext.subarray(
						ciphertext.length - tagLength,
					);
					const decipher = createDecipheriv(
						`aes-${rawKey.length * 8}-gcm` as any,
						rawKey,
						iv,
						{ authTagLength: tagLength } as any,
					) as any;
					decipher.setAuthTag(authTag);
					if (algorithm.additionalData) {
						decipher.setAAD(
							Buffer.from(algorithm.additionalData, "base64"),
						);
					}
					const decrypted = Buffer.concat([
						decipher.update(encData),
						decipher.final(),
					]);
					return JSON.stringify({ data: decrypted.toString("base64") });
				}
				if (algoName === "AES-CBC") {
					const iv = Buffer.from(algorithm.iv, "base64");
					const decipher = createDecipheriv(
						`aes-${rawKey.length * 8}-cbc` as any,
						rawKey,
						iv,
					);
					const decrypted = Buffer.concat([
						decipher.update(ciphertext),
						decipher.final(),
					]);
					return JSON.stringify({ data: decrypted.toString("base64") });
				}
				throw new Error(`Unsupported decrypt algorithm: ${algoName}`);
			}
			case "sign": {
				const { key, data } = req;
				const dataBytes = Buffer.from(data, "base64");
				const algoName = key.algorithm.name;
				if (algoName === "HMAC") {
					const rawKey = Buffer.from(key._raw, "base64");
					const hashAlgo = normalizeHash(key.algorithm.hash);
					return JSON.stringify({
						data: createHmac(hashAlgo, rawKey)
							.update(dataBytes)
							.digest("base64"),
					});
				}
				if (algoName === "RSASSA-PKCS1-v1_5") {
					const hashAlgo = normalizeHash(key.algorithm.hash);
					const pkey = createPrivateKey(key._pem);
					return JSON.stringify({
						data: sign(hashAlgo, dataBytes, pkey).toString("base64"),
					});
				}
				throw new Error(`Unsupported sign algorithm: ${algoName}`);
			}
			case "verify": {
				const { key, signature, data } = req;
				const dataBytes = Buffer.from(data, "base64");
				const sigBytes = Buffer.from(signature, "base64");
				const algoName = key.algorithm.name;
				if (algoName === "HMAC") {
					const rawKey = Buffer.from(key._raw, "base64");
					const hashAlgo = normalizeHash(key.algorithm.hash);
					const expected = createHmac(hashAlgo, rawKey)
						.update(dataBytes)
						.digest();
					if (expected.length !== sigBytes.length)
						return JSON.stringify({ result: false });
					return JSON.stringify({
						result: timingSafeEqual(expected, sigBytes),
					});
				}
				if (algoName === "RSASSA-PKCS1-v1_5") {
					const hashAlgo = normalizeHash(key.algorithm.hash);
					const pkey = createPublicKey(key._pem);
					return JSON.stringify({
						result: verify(hashAlgo, dataBytes, pkey, sigBytes),
					});
				}
				throw new Error(`Unsupported verify algorithm: ${algoName}`);
			}
			case "deriveBits": {
				const { algorithm, baseKey, length } = req;
				const algoName = algorithm.name;
				const bitLength = length;
				const byteLength = bitLength / 8;
				if (algoName === "PBKDF2") {
					const password = Buffer.from(baseKey._raw, "base64");
					const salt = Buffer.from(algorithm.salt, "base64");
					const hash = normalizeHash(algorithm.hash);
					const derived = pbkdf2Sync(
						password,
						salt,
						algorithm.iterations,
						byteLength,
						hash,
					);
					return JSON.stringify({ data: derived.toString("base64") });
				}
				if (algoName === "HKDF") {
					const ikm = Buffer.from(baseKey._raw, "base64");
					const salt = Buffer.from(algorithm.salt, "base64");
					const info = Buffer.from(algorithm.info, "base64");
					const hash = normalizeHash(algorithm.hash);
					const derived = Buffer.from(
						hkdfSync(hash, ikm, salt, info, byteLength),
					);
					return JSON.stringify({ data: derived.toString("base64") });
				}
				throw new Error(`Unsupported deriveBits algorithm: ${algoName}`);
			}
			case "deriveKey": {
				const { algorithm, baseKey, derivedKeyAlgorithm, extractable, usages } = req;
				const algoName = algorithm.name;
				const keyLengthBits = derivedKeyAlgorithm.length;
				const byteLength = keyLengthBits / 8;
				if (algoName === "PBKDF2") {
					const password = Buffer.from(baseKey._raw, "base64");
					const salt = Buffer.from(algorithm.salt, "base64");
					const hash = normalizeHash(algorithm.hash);
					const derived = pbkdf2Sync(
						password,
						salt,
						algorithm.iterations,
						byteLength,
						hash,
					);
					return JSON.stringify({
						key: {
							type: "secret",
							algorithm: derivedKeyAlgorithm,
							extractable,
							usages,
							_raw: derived.toString("base64"),
						},
					});
				}
				if (algoName === "HKDF") {
					const ikm = Buffer.from(baseKey._raw, "base64");
					const salt = Buffer.from(algorithm.salt, "base64");
					const info = Buffer.from(algorithm.info, "base64");
					const hash = normalizeHash(algorithm.hash);
					const derived = Buffer.from(
						hkdfSync(hash, ikm, salt, info, byteLength),
					);
					return JSON.stringify({
						key: {
							type: "secret",
							algorithm: derivedKeyAlgorithm,
							extractable,
							usages,
							_raw: derived.toString("base64"),
						},
					});
				}
				throw new Error(`Unsupported deriveKey algorithm: ${algoName}`);
			}
			default:
				throw new Error(`Unsupported subtle operation: ${req.op}`);
		}
	};

	const dispose = () => {
		cipherSessions.clear();
	};

	return { handlers, dispose };
}

/** Dependencies for building net socket bridge handlers. */
export interface NetSocketBridgeDeps {
	/** Dispatch a socket event back to the guest (socketId, event, data?). */
	dispatch: (socketId: number, event: string, data?: string) => void;
}

/** Result of building net socket bridge handlers — includes dispose for cleanup. */
export interface NetSocketBridgeResult {
	handlers: BridgeHandlers;
	dispose: () => void;
}

/**
 * Build net socket bridge handlers.
 *
 * Creates handlers for TCP socket operations (connect, write, end, destroy).
 * The host creates real net.Socket instances and dispatches events (connect,
 * data, end, error, close) back to the guest via the provided dispatch function.
 * Call dispose() when the execution ends to destroy all open sockets.
 */
export function buildNetworkSocketBridgeHandlers(
	deps: NetSocketBridgeDeps,
): NetSocketBridgeResult {
	const handlers: BridgeHandlers = {};
	const K = HOST_BRIDGE_GLOBAL_KEYS;

	// Track open sockets per execution for cleanup on dispose.
	const sockets = new Map<number, net.Socket>();
	let nextSocketId = 1;

	// Connect — create a real TCP socket on the host.
	// Returns socketId; events are dispatched via deps.dispatch.
	handlers[K.netSocketConnectRaw] = (host: unknown, port: unknown) => {
		const socketId = nextSocketId++;
		const socket = net.connect({ host: String(host), port: Number(port) });
		sockets.set(socketId, socket);

		socket.on("connect", () => deps.dispatch(socketId, "connect"));
		socket.on("data", (chunk: Buffer) =>
			deps.dispatch(socketId, "data", chunk.toString("base64")),
		);
		socket.on("end", () => deps.dispatch(socketId, "end"));
		socket.on("error", (err: Error) =>
			deps.dispatch(socketId, "error", err.message),
		);
		socket.on("close", () => {
			sockets.delete(socketId);
			deps.dispatch(socketId, "close");
		});

		return socketId;
	};

	// Write — send data to an open socket.
	handlers[K.netSocketWriteRaw] = (
		socketId: unknown,
		dataBase64: unknown,
	) => {
		const socket = sockets.get(Number(socketId));
		if (!socket) throw new Error(`Socket ${socketId} not found`);
		socket.write(Buffer.from(String(dataBase64), "base64"));
	};

	// End — half-close the socket (send FIN).
	handlers[K.netSocketEndRaw] = (socketId: unknown) => {
		sockets.get(Number(socketId))?.end();
	};

	// Destroy — forcefully tear down the socket.
	handlers[K.netSocketDestroyRaw] = (socketId: unknown) => {
		const id = Number(socketId);
		const socket = sockets.get(id);
		if (socket) {
			socket.destroy();
			sockets.delete(id);
		}
	};

	// TLS upgrade — wrap existing TCP socket with tls.TLSSocket.
	// Re-wires events through the same dispatch mechanism with secureConnect event.
	handlers[K.netSocketUpgradeTlsRaw] = (
		socketId: unknown,
		optionsJson: unknown,
	) => {
		const id = Number(socketId);
		const socket = sockets.get(id);
		if (!socket) throw new Error(`Socket ${id} not found for TLS upgrade`);

		const options = optionsJson ? JSON.parse(String(optionsJson)) : {};

		// Remove existing listeners before wrapping — TLS socket will emit its own events
		socket.removeAllListeners();

		const tlsSocket = tls.connect({
			socket,
			rejectUnauthorized: options.rejectUnauthorized ?? false,
			servername: options.servername,
			...( options.minVersion ? { minVersion: options.minVersion } : {}),
			...( options.maxVersion ? { maxVersion: options.maxVersion } : {}),
		});

		// Replace in map so write/end/destroy operate on the TLS socket
		sockets.set(id, tlsSocket as unknown as net.Socket);

		tlsSocket.on("secureConnect", () =>
			deps.dispatch(id, "secureConnect"),
		);
		tlsSocket.on("data", (chunk: Buffer) =>
			deps.dispatch(id, "data", chunk.toString("base64")),
		);
		tlsSocket.on("end", () => deps.dispatch(id, "end"));
		tlsSocket.on("error", (err: Error) =>
			deps.dispatch(id, "error", err.message),
		);
		tlsSocket.on("close", () => {
			sockets.delete(id);
			deps.dispatch(id, "close");
		});
	};

	const dispose = () => {
		for (const socket of sockets.values()) {
			socket.destroy();
		}
		sockets.clear();
	};

	return { handlers, dispose };
}

/** Dependencies for building upgrade socket bridge handlers. */
export interface UpgradeSocketBridgeDeps {
	/** Write data to an upgrade socket. */
	write: (socketId: number, dataBase64: string) => void;
	/** End an upgrade socket. */
	end: (socketId: number) => void;
	/** Destroy an upgrade socket. */
	destroy: (socketId: number) => void;
}

/**
 * Build upgrade socket bridge handlers.
 *
 * Creates handlers for HTTP upgrade socket operations (write, end, destroy).
 * These forward to the NetworkAdapter's upgrade socket methods for
 * bidirectional WebSocket relay.
 */
export function buildUpgradeSocketBridgeHandlers(
	deps: UpgradeSocketBridgeDeps,
): BridgeHandlers {
	const handlers: BridgeHandlers = {};
	const K = HOST_BRIDGE_GLOBAL_KEYS;

	// Write data to an upgrade socket.
	handlers[K.upgradeSocketWriteRaw] = (
		socketId: unknown,
		dataBase64: unknown,
	) => {
		deps.write(Number(socketId), String(dataBase64));
	};

	// End an upgrade socket.
	handlers[K.upgradeSocketEndRaw] = (socketId: unknown) => {
		deps.end(Number(socketId));
	};

	// Destroy an upgrade socket.
	handlers[K.upgradeSocketDestroyRaw] = (socketId: unknown) => {
		deps.destroy(Number(socketId));
	};

	return handlers;
}

/** Dependencies for building sync module resolution bridge handlers. */
export interface ModuleResolutionBridgeDeps {
	/** Translate sandbox path (e.g. /root/node_modules/...) to host path. */
	sandboxToHostPath: (sandboxPath: string) => string | null;
	/** Translate host path back to sandbox path. */
	hostToSandboxPath: (hostPath: string) => string;
}

const hostRequire = createRequire(import.meta.url);

/**
 * Build sync module resolution bridge handlers.
 *
 * These use Node.js require.resolve() and readFileSync() directly,
 * avoiding the async VirtualFileSystem path. Needed because the async
 * applySyncPromise pattern can't nest inside synchronous bridge
 * callbacks (e.g. net socket data events that trigger require()).
 */
export function buildModuleResolutionBridgeHandlers(
	deps: ModuleResolutionBridgeDeps,
): BridgeHandlers {
	const handlers: BridgeHandlers = {};
	const K = HOST_BRIDGE_GLOBAL_KEYS;

	// Sync require.resolve — translates sandbox paths and uses Node.js resolution.
	handlers[K.resolveModuleSync] = (request: unknown, fromDir: unknown) => {
		const req = String(request);

		// Builtins don't need filesystem resolution
		const builtin = normalizeBuiltinSpecifier(req);
		if (builtin) return builtin;

		// Translate sandbox fromDir to host path for resolution context
		const sandboxDir = String(fromDir);
		const hostDir = deps.sandboxToHostPath(sandboxDir) ?? sandboxDir;

		try {
			const resolved = hostRequire.resolve(req, { paths: [hostDir] });
			// Translate resolved host path back to sandbox path
			return deps.hostToSandboxPath(resolved);
		} catch {
			return null;
		}
	};

	// Sync file read — translates sandbox path and reads via readFileSync.
	// Also transforms dynamic import() calls for V8 compatibility.
	handlers[K.loadFileSync] = (filePath: unknown) => {
		const sandboxPath = String(filePath);
		const hostPath = deps.sandboxToHostPath(sandboxPath) ?? sandboxPath;

		try {
			const source = readFileSync(hostPath, "utf-8");
			return transformDynamicImport(source);
		} catch {
			return null;
		}
	};

	return handlers;
}

// Env vars that could hijack child processes (library injection, node flags)
const DANGEROUS_ENV_KEYS = new Set([
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"NODE_OPTIONS",
	"DYLD_INSERT_LIBRARIES",
]);

/** Strip env vars that allow library injection or node flag smuggling. */
export function stripDangerousEnv(
	env: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (!env) return env;
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (!DANGEROUS_ENV_KEYS.has(key)) {
			result[key] = value;
		}
	}
	return result;
}

export function emitConsoleEvent(
	onStdio: StdioHook | undefined,
	event: StdioEvent,
): void {
	if (!onStdio) return;
	try {
		onStdio(event);
	} catch {
		// Keep runtime execution deterministic even when host hooks fail.
	}
}

/** Dependencies for console bridge handlers. */
export interface ConsoleBridgeDeps {
	onStdio?: StdioHook;
	budgetState: BudgetState;
	maxOutputBytes?: number;
}

/** Build console/logging bridge handlers. */
export function buildConsoleBridgeHandlers(deps: ConsoleBridgeDeps): BridgeHandlers {
	const handlers: BridgeHandlers = {};
	const K = HOST_BRIDGE_GLOBAL_KEYS;

	handlers[K.log] = (msg: unknown) => {
		const str = String(msg);
		if (deps.maxOutputBytes !== undefined) {
			const bytes = Buffer.byteLength(str, "utf8");
			if (deps.budgetState.outputBytes + bytes > deps.maxOutputBytes) return;
			deps.budgetState.outputBytes += bytes;
		}
		emitConsoleEvent(deps.onStdio, { channel: "stdout", message: str });
	};

	handlers[K.error] = (msg: unknown) => {
		const str = String(msg);
		if (deps.maxOutputBytes !== undefined) {
			const bytes = Buffer.byteLength(str, "utf8");
			if (deps.budgetState.outputBytes + bytes > deps.maxOutputBytes) return;
			deps.budgetState.outputBytes += bytes;
		}
		emitConsoleEvent(deps.onStdio, { channel: "stderr", message: str });
	};

	return handlers;
}

/** Dependencies for module loading bridge handlers. */
export interface ModuleLoadingBridgeDeps {
	filesystem: VirtualFileSystem;
	resolutionCache: ResolutionCache;
}

/** Build module loading bridge handlers (loadPolyfill, resolveModule, loadFile). */
export function buildModuleLoadingBridgeHandlers(
	deps: ModuleLoadingBridgeDeps,
	/** Extra handlers to dispatch through _loadPolyfill for V8 runtime compatibility. */
	dispatchHandlers?: BridgeHandlers,
): BridgeHandlers {
	const handlers: BridgeHandlers = {};
	const K = HOST_BRIDGE_GLOBAL_KEYS;

	// Polyfill loading — also serves as bridge dispatch multiplexer.
	// The V8 runtime binary only registers a fixed set of bridge globals.
	// Newer handlers (crypto, net sockets, etc.) are dispatched through
	// _loadPolyfill with a "__bd:" prefix.
	handlers[K.loadPolyfill] = async (moduleName: unknown): Promise<string | null> => {
		const nameStr = String(moduleName);

		// Bridge dispatch: "__bd:methodName:base64args"
		if (nameStr.startsWith("__bd:") && dispatchHandlers) {
			const colonIdx = nameStr.indexOf(":", 5);
			const method = nameStr.substring(5, colonIdx > 0 ? colonIdx : undefined);
			const argsJson = colonIdx > 0 ? nameStr.substring(colonIdx + 1) : "[]";
			const handler = dispatchHandlers[method];
			if (!handler) return JSON.stringify({ __bd_error: `No handler: ${method}` });
			try {
				const args = JSON.parse(argsJson);
				const result = await handler(...(Array.isArray(args) ? args : [args]));
				return JSON.stringify({ __bd_result: result });
			} catch (err) {
				return JSON.stringify({ __bd_error: err instanceof Error ? err.message : String(err) });
			}
		}

		const name = nameStr.replace(/^node:/, "");
		if (name === "fs" || name === "child_process" || name === "http" ||
			name === "https" || name === "http2" || name === "dns" ||
			name === "os" || name === "module") {
			return null;
		}
		if (!hasPolyfill(name)) return null;
		let code = polyfillCodeCache.get(name);
		if (!code) {
			code = await bundlePolyfill(name);
			polyfillCodeCache.set(name, code);
		}
		return code;
	};

	// Async module path resolution via VFS
	handlers[K.resolveModule] = async (request: unknown, fromDir: unknown): Promise<string | null> => {
		const req = String(request);
		const builtin = normalizeBuiltinSpecifier(req);
		if (builtin) return builtin;
		return resolveModule(req, String(fromDir), deps.filesystem, "require", deps.resolutionCache);
	};

	// Async file read + dynamic import transform
	handlers[K.loadFile] = async (path: unknown): Promise<string | null> => {
		const source = await loadFile(String(path), deps.filesystem);
		if (source === null) return null;
		return transformDynamicImport(source);
	};

	return handlers;
}

/** Dependencies for timer bridge handlers. */
export interface TimerBridgeDeps {
	budgetState: BudgetState;
	maxBridgeCalls?: number;
	activeHostTimers: Set<ReturnType<typeof setTimeout>>;
}

/** Build timer bridge handler. */
export function buildTimerBridgeHandlers(deps: TimerBridgeDeps): BridgeHandlers {
	const handlers: BridgeHandlers = {};
	const K = HOST_BRIDGE_GLOBAL_KEYS;

	handlers[K.scheduleTimer] = (delayMs: unknown) => {
		checkBridgeBudget(deps);
		return new Promise<void>((resolve) => {
			const id = globalThis.setTimeout(() => {
				deps.activeHostTimers.delete(id);
				resolve();
			}, Number(delayMs));
			deps.activeHostTimers.add(id);
		});
	};

	return handlers;
}

/** Dependencies for filesystem bridge handlers. */
export interface FsBridgeDeps {
	filesystem: VirtualFileSystem;
	budgetState: BudgetState;
	maxBridgeCalls?: number;
	bridgeBase64TransferLimitBytes: number;
	isolateJsonPayloadLimitBytes: number;
}

/** Build filesystem bridge handlers (readFile, writeFile, stat, etc.). */
export function buildFsBridgeHandlers(deps: FsBridgeDeps): BridgeHandlers {
	const handlers: BridgeHandlers = {};
	const K = HOST_BRIDGE_GLOBAL_KEYS;
	const fs = deps.filesystem;
	const base64Limit = deps.bridgeBase64TransferLimitBytes;
	const jsonLimit = deps.isolateJsonPayloadLimitBytes;

	handlers[K.fsReadFile] = async (path: unknown) => {
		checkBridgeBudget(deps);
		const text = await fs.readTextFile(String(path));
		assertTextPayloadSize(`fs.readFile ${path}`, text, jsonLimit);
		return text;
	};

	handlers[K.fsWriteFile] = async (path: unknown, content: unknown) => {
		checkBridgeBudget(deps);
		await fs.writeFile(String(path), String(content));
	};

	handlers[K.fsReadFileBinary] = async (path: unknown) => {
		checkBridgeBudget(deps);
		const data = await fs.readFile(String(path));
		assertPayloadByteLength(`fs.readFileBinary ${path}`, getBase64EncodedByteLength(data.byteLength), base64Limit);
		return Buffer.from(data).toString("base64");
	};

	handlers[K.fsWriteFileBinary] = async (path: unknown, base64Content: unknown) => {
		checkBridgeBudget(deps);
		const b64 = String(base64Content);
		assertTextPayloadSize(`fs.writeFileBinary ${path}`, b64, base64Limit);
		await fs.writeFile(String(path), Buffer.from(b64, "base64"));
	};

	handlers[K.fsReadDir] = async (path: unknown) => {
		checkBridgeBudget(deps);
		const entries = await fs.readDirWithTypes(String(path));
		const json = JSON.stringify(entries);
		assertTextPayloadSize(`fs.readDir ${path}`, json, jsonLimit);
		return json;
	};

	handlers[K.fsMkdir] = async (path: unknown) => {
		checkBridgeBudget(deps);
		await mkdir(fs, String(path));
	};

	handlers[K.fsRmdir] = async (path: unknown) => {
		checkBridgeBudget(deps);
		await fs.removeDir(String(path));
	};

	handlers[K.fsExists] = async (path: unknown) => {
		checkBridgeBudget(deps);
		return fs.exists(String(path));
	};

	handlers[K.fsStat] = async (path: unknown) => {
		checkBridgeBudget(deps);
		const s = await fs.stat(String(path));
		return JSON.stringify({ mode: s.mode, size: s.size, isDirectory: s.isDirectory,
			atimeMs: s.atimeMs, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, birthtimeMs: s.birthtimeMs });
	};

	handlers[K.fsUnlink] = async (path: unknown) => {
		checkBridgeBudget(deps);
		await fs.removeFile(String(path));
	};

	handlers[K.fsRename] = async (oldPath: unknown, newPath: unknown) => {
		checkBridgeBudget(deps);
		await fs.rename(String(oldPath), String(newPath));
	};

	handlers[K.fsChmod] = async (path: unknown, mode: unknown) => {
		checkBridgeBudget(deps);
		await fs.chmod(String(path), Number(mode));
	};

	handlers[K.fsChown] = async (path: unknown, uid: unknown, gid: unknown) => {
		checkBridgeBudget(deps);
		await fs.chown(String(path), Number(uid), Number(gid));
	};

	handlers[K.fsLink] = async (oldPath: unknown, newPath: unknown) => {
		checkBridgeBudget(deps);
		await fs.link(String(oldPath), String(newPath));
	};

	handlers[K.fsSymlink] = async (target: unknown, linkPath: unknown) => {
		checkBridgeBudget(deps);
		await fs.symlink(String(target), String(linkPath));
	};

	handlers[K.fsReadlink] = async (path: unknown) => {
		checkBridgeBudget(deps);
		return fs.readlink(String(path));
	};

	handlers[K.fsLstat] = async (path: unknown) => {
		checkBridgeBudget(deps);
		const s = await fs.lstat(String(path));
		return JSON.stringify({ mode: s.mode, size: s.size, isDirectory: s.isDirectory,
			isSymbolicLink: s.isSymbolicLink, atimeMs: s.atimeMs, mtimeMs: s.mtimeMs,
			ctimeMs: s.ctimeMs, birthtimeMs: s.birthtimeMs });
	};

	handlers[K.fsTruncate] = async (path: unknown, length: unknown) => {
		checkBridgeBudget(deps);
		await fs.truncate(String(path), Number(length));
	};

	handlers[K.fsUtimes] = async (path: unknown, atime: unknown, mtime: unknown) => {
		checkBridgeBudget(deps);
		await fs.utimes(String(path), Number(atime), Number(mtime));
	};

	return handlers;
}

/** Dependencies for child process bridge handlers. */
export interface ChildProcessBridgeDeps {
	commandExecutor: CommandExecutor;
	processConfig: ProcessConfig;
	budgetState: BudgetState;
	maxBridgeCalls?: number;
	maxChildProcesses?: number;
	isolateJsonPayloadLimitBytes: number;
	activeChildProcesses: Map<number, SpawnedProcess>;
	/** Push child process events into the V8 isolate. */
	sendStreamEvent: (eventType: string, payload: Uint8Array) => void;
}

/** Build child process bridge handlers. */
export function buildChildProcessBridgeHandlers(deps: ChildProcessBridgeDeps): BridgeHandlers {
	const handlers: BridgeHandlers = {};
	const K = HOST_BRIDGE_GLOBAL_KEYS;
	const jsonLimit = deps.isolateJsonPayloadLimitBytes;
	let nextSessionId = 1;
	const sessions = deps.activeChildProcesses;

	// Serialize a child process event and push it into the V8 isolate
	const dispatchEvent = (sessionId: number, type: string, data?: Uint8Array | number) => {
		try {
			const payload = JSON.stringify({ sessionId, type, data: data instanceof Uint8Array ? Buffer.from(data).toString("base64") : data });
			deps.sendStreamEvent("childProcess", Buffer.from(payload));
		} catch {
			// Context may be disposed
		}
	};

	handlers[K.childProcessSpawnStart] = (command: unknown, argsJson: unknown, optionsJson: unknown): number => {
		checkBridgeBudget(deps);
		if (deps.maxChildProcesses !== undefined && deps.budgetState.childProcesses >= deps.maxChildProcesses) {
			throw new Error(`${RESOURCE_BUDGET_ERROR_CODE}: maximum child processes exceeded`);
		}
		deps.budgetState.childProcesses++;
		const args = parseJsonWithLimit<string[]>("child_process.spawn args", String(argsJson), jsonLimit);
		const options = parseJsonWithLimit<{ cwd?: string; env?: Record<string, string> }>(
			"child_process.spawn options", String(optionsJson), jsonLimit);
		const sessionId = nextSessionId++;
		const childEnv = stripDangerousEnv(options.env ?? deps.processConfig.env);

		const proc = deps.commandExecutor.spawn(String(command), args, {
			cwd: options.cwd,
			env: childEnv,
			onStdout: (data) => dispatchEvent(sessionId, "stdout", data),
			onStderr: (data) => dispatchEvent(sessionId, "stderr", data),
		});

		proc.wait().then((code) => {
			dispatchEvent(sessionId, "exit", code);
			sessions.delete(sessionId);
		});

		sessions.set(sessionId, proc);
		return sessionId;
	};

	handlers[K.childProcessStdinWrite] = (sessionId: unknown, data: unknown) => {
		const d = data instanceof Uint8Array ? data : Buffer.from(String(data), "base64");
		sessions.get(Number(sessionId))?.writeStdin(d);
	};

	handlers[K.childProcessStdinClose] = (sessionId: unknown) => {
		sessions.get(Number(sessionId))?.closeStdin();
	};

	handlers[K.childProcessKill] = (sessionId: unknown, signal: unknown) => {
		sessions.get(Number(sessionId))?.kill(Number(signal));
	};

	handlers[K.childProcessSpawnSync] = async (command: unknown, argsJson: unknown, optionsJson: unknown): Promise<string> => {
		checkBridgeBudget(deps);
		if (deps.maxChildProcesses !== undefined && deps.budgetState.childProcesses >= deps.maxChildProcesses) {
			throw new Error(`${RESOURCE_BUDGET_ERROR_CODE}: maximum child processes exceeded`);
		}
		deps.budgetState.childProcesses++;
		const args = parseJsonWithLimit<string[]>("child_process.spawnSync args", String(argsJson), jsonLimit);
		const options = parseJsonWithLimit<{ cwd?: string; env?: Record<string, string>; maxBuffer?: number }>(
			"child_process.spawnSync options", String(optionsJson), jsonLimit);

		const maxBuffer = options.maxBuffer ?? 1024 * 1024;
		const stdoutChunks: Uint8Array[] = [];
		const stderrChunks: Uint8Array[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let maxBufferExceeded = false;

		const childEnv = stripDangerousEnv(options.env ?? deps.processConfig.env);

		const proc = deps.commandExecutor.spawn(String(command), args, {
			cwd: options.cwd,
			env: childEnv,
			onStdout: (data) => {
				if (maxBufferExceeded) return;
				stdoutBytes += data.length;
				if (maxBuffer !== undefined && stdoutBytes > maxBuffer) {
					maxBufferExceeded = true;
					proc.kill(15);
					return;
				}
				stdoutChunks.push(data);
			},
			onStderr: (data) => {
				if (maxBufferExceeded) return;
				stderrBytes += data.length;
				if (maxBuffer !== undefined && stderrBytes > maxBuffer) {
					maxBufferExceeded = true;
					proc.kill(15);
					return;
				}
				stderrChunks.push(data);
			},
		});

		const exitCode = await proc.wait();
		const decoder = new TextDecoder();
		const stdout = stdoutChunks.map((c) => decoder.decode(c)).join("");
		const stderr = stderrChunks.map((c) => decoder.decode(c)).join("");
		return JSON.stringify({ stdout, stderr, code: exitCode, maxBufferExceeded });
	};

	return handlers;
}

/** Dependencies for network bridge handlers. */
export interface NetworkBridgeDeps {
	networkAdapter: NetworkAdapter;
	budgetState: BudgetState;
	maxBridgeCalls?: number;
	isolateJsonPayloadLimitBytes: number;
	activeHttpServerIds: Set<number>;
	/** Push HTTP server/upgrade events into the V8 isolate. */
	sendStreamEvent: (eventType: string, payload: Uint8Array) => void;
}

/** Build network bridge handlers (fetch, httpRequest, dnsLookup, httpServer). */
export function buildNetworkBridgeHandlers(deps: NetworkBridgeDeps): BridgeHandlers {
	const handlers: BridgeHandlers = {};
	const K = HOST_BRIDGE_GLOBAL_KEYS;
	const adapter = deps.networkAdapter;
	const jsonLimit = deps.isolateJsonPayloadLimitBytes;
	const ownedHttpServers = new Set<number>();

	handlers[K.networkFetchRaw] = (url: unknown, optionsJson: unknown): Promise<string> => {
		checkBridgeBudget(deps);
		const options = parseJsonWithLimit<{ method?: string; headers?: Record<string, string>; body?: string | null }>(
			"network.fetch options", String(optionsJson), jsonLimit);
		return adapter.fetch(String(url), options).then((result) => {
			const json = JSON.stringify(result);
			assertTextPayloadSize("network.fetch response", json, jsonLimit);
			return json;
		});
	};

	handlers[K.networkDnsLookupRaw] = async (hostname: unknown): Promise<string> => {
		checkBridgeBudget(deps);
		const result = await adapter.dnsLookup(String(hostname));
		return JSON.stringify(result);
	};

	handlers[K.networkHttpRequestRaw] = (url: unknown, optionsJson: unknown): Promise<string> => {
		checkBridgeBudget(deps);
		const options = parseJsonWithLimit<{ method?: string; headers?: Record<string, string>; body?: string | null; rejectUnauthorized?: boolean }>(
			"network.httpRequest options", String(optionsJson), jsonLimit);
		return adapter.httpRequest(String(url), options).then((result) => {
			const json = JSON.stringify(result);
			assertTextPayloadSize("network.httpRequest response", json, jsonLimit);
			return json;
		});
	};

	handlers[K.networkHttpServerListenRaw] = (optionsJson: unknown): Promise<string> => {
		if (!adapter.httpServerListen) {
			throw new Error("http.createServer requires NetworkAdapter.httpServerListen support");
		}
		const options = parseJsonWithLimit<{ serverId: number; port?: number; hostname?: string }>(
			"network.httpServer.listen options", String(optionsJson), jsonLimit);

		return (async () => {
			const result = await adapter.httpServerListen!({
				serverId: options.serverId,
				port: options.port,
				hostname: options.hostname,
				onRequest: async (request) => {
					const requestJson = JSON.stringify(request);
					const responsePromise = new Promise<string>((resolve) => {
						pendingHttpResponses.set(options.serverId, resolve);
					});
					deps.sendStreamEvent("httpServerRequest", Buffer.from(JSON.stringify({
						serverId: options.serverId, request: requestJson,
					})));
					const responseJson = await responsePromise;
					return parseJsonWithLimit<{
						status: number;
						headers?: Array<[string, string]>;
						body?: string;
						bodyEncoding?: "utf8" | "base64";
					}>("network.httpServer response", responseJson, jsonLimit);
				},
				onUpgrade: (request, head, socketId) => {
					deps.sendStreamEvent("httpServerUpgrade", Buffer.from(JSON.stringify({
						serverId: options.serverId,
						request: JSON.stringify(request),
						head,
						socketId,
					})));
				},
				onUpgradeSocketData: (socketId, dataBase64) => {
					deps.sendStreamEvent("upgradeSocketData", Buffer.from(JSON.stringify({
						socketId, dataBase64,
					})));
				},
				onUpgradeSocketEnd: (socketId) => {
					deps.sendStreamEvent("upgradeSocketEnd", Buffer.from(JSON.stringify({ socketId })));
				},
			});
			ownedHttpServers.add(options.serverId);
			deps.activeHttpServerIds.add(options.serverId);
			return JSON.stringify(result);
		})();
	};

	handlers[K.networkHttpServerCloseRaw] = (serverId: unknown): Promise<void> => {
		const id = Number(serverId);
		if (!adapter.httpServerClose) {
			throw new Error("http.createServer close requires NetworkAdapter.httpServerClose support");
		}
		if (!ownedHttpServers.has(id)) {
			throw new Error(`Cannot close server ${id}: not owned by this execution context`);
		}
		return adapter.httpServerClose(id).then(() => {
			ownedHttpServers.delete(id);
			deps.activeHttpServerIds.delete(id);
		});
	};

	// Register upgrade socket callbacks for httpRequest client-side upgrades
	adapter.setUpgradeSocketCallbacks?.({
		onData: (socketId, dataBase64) => {
			deps.sendStreamEvent("upgradeSocketData", Buffer.from(JSON.stringify({ socketId, dataBase64 })));
		},
		onEnd: (socketId) => {
			deps.sendStreamEvent("upgradeSocketEnd", Buffer.from(JSON.stringify({ socketId })));
		},
	});

	return handlers;
}

// Pending HTTP server response callbacks, keyed by serverId
const pendingHttpResponses = new Map<number, (response: string) => void>();

/** Resolve a pending HTTP server response (called from stream callback handler). */
export function resolveHttpServerResponse(serverId: number, responseJson: string): void {
	const resolve = pendingHttpResponses.get(serverId);
	if (resolve) {
		pendingHttpResponses.delete(serverId);
		resolve(responseJson);
	}
}

/** Dependencies for PTY bridge handlers. */
export interface PtyBridgeDeps {
	onPtySetRawMode?: (mode: boolean) => void;
	stdinIsTTY?: boolean;
}

/** Build PTY bridge handlers. */
export function buildPtyBridgeHandlers(deps: PtyBridgeDeps): BridgeHandlers {
	const handlers: BridgeHandlers = {};
	const K = HOST_BRIDGE_GLOBAL_KEYS;

	if (deps.stdinIsTTY && deps.onPtySetRawMode) {
		handlers[K.ptySetRawMode] = (mode: unknown) => {
			deps.onPtySetRawMode!(Boolean(mode));
		};
	}

	return handlers;
}

export function createProcessConfigForExecution(
	processConfig: ProcessConfig,
	timingMitigation: string,
	frozenTimeMs: number,
): ProcessConfig {
	return {
		...processConfig,
		timingMitigation: timingMitigation as ProcessConfig["timingMitigation"],
		frozenTimeMs: timingMitigation === "freeze" ? frozenTimeMs : undefined,
	};
}
