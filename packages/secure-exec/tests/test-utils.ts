import {
	NodeRuntime,
	createInMemoryFileSystem,
	createNodeDriver,
	createNodeRuntimeDriverFactory,
} from "../src/index.js";
import type {
	CommandExecutor,
	NetworkAdapter,
	Permissions,
	RuntimeDriverFactory,
	SystemDriver,
	VirtualFileSystem,
} from "../src/types.js";
import type {
	StdioHook,
	OSConfig,
	ProcessConfig,
	TimingMitigation,
} from "../src/shared/api-types.js";
import type { ModuleAccessOptions } from "../src/node/driver.js";
import type { ResourceBudgets } from "../src/runtime-driver.js";

export function createTestFileSystem(): VirtualFileSystem {
	return createInMemoryFileSystem();
}

export type LegacyNodeRuntimeOptions = {
	driver?: SystemDriver;
	executionFactory?: RuntimeDriverFactory;
	systemDriver?: SystemDriver;
	runtimeDriverFactory?: RuntimeDriverFactory;
	filesystem?: VirtualFileSystem;
	moduleAccess?: ModuleAccessOptions;
	networkAdapter?: NetworkAdapter;
	commandExecutor?: CommandExecutor;
	permissions?: Permissions;
	processConfig?: ProcessConfig;
	osConfig?: OSConfig;
	memoryLimit?: number;
	cpuTimeLimitMs?: number;
	timingMitigation?: TimingMitigation;
	onStdio?: StdioHook;
	payloadLimits?: {
		base64TransferBytes?: number;
		jsonPayloadBytes?: number;
	};
	resourceBudgets?: ResourceBudgets;
};

export function createTestNodeRuntime(
	options: LegacyNodeRuntimeOptions = {},
): NodeRuntime {
	const {
		driver,
		executionFactory,
		systemDriver,
		runtimeDriverFactory,
		filesystem,
		moduleAccess,
		networkAdapter,
		commandExecutor,
		permissions,
		processConfig,
		osConfig,
		...nodeProcessOptions
	} = options;

	const baseSystemDriver = systemDriver ?? driver;
	const resolvedSystemDriver = baseSystemDriver
		? {
				...baseSystemDriver,
				runtime: {
					process: {
						...(baseSystemDriver.runtime.process ?? {}),
						...(processConfig ?? {}),
					},
					os: {
						...(baseSystemDriver.runtime.os ?? {}),
						...(osConfig ?? {}),
					},
				},
			}
		: createNodeDriver({
				filesystem,
				moduleAccess,
				networkAdapter,
				commandExecutor,
				permissions,
				processConfig,
				osConfig,
			});
	const resolvedRuntimeDriverFactory =
		runtimeDriverFactory ??
		executionFactory ??
		createNodeRuntimeDriverFactory();

	return new NodeRuntime({
		...nodeProcessOptions,
		systemDriver: resolvedSystemDriver,
		runtimeDriverFactory: resolvedRuntimeDriverFactory,
	});
}
