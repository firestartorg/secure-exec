// VFS and permission types — canonical source is @firestart/secure-exec-core
export type {
	ChildProcessAccessRequest,
	EnvAccessRequest,
	FsAccessRequest,
	NetworkAccessRequest,
	PermissionCheck,
	PermissionDecision,
	Permissions,
	VirtualDirEntry,
	VirtualFileSystem,
	VirtualStat,
} from "@firestart/secure-exec-core";

// Core-only types
export type {
	CommandExecutor,
	NetworkAdapter,
	NetworkServerAddress,
	NetworkServerListenOptions,
	NetworkServerRequest,
	NetworkServerResponse,
	SpawnedProcess,
} from "@firestart/secure-exec-core";

export type {
	DriverRuntimeConfig,
	NodeRuntimeDriver,
	NodeRuntimeDriverFactory,
	PythonRuntimeDriver,
	PythonRuntimeDriverFactory,
	RuntimeDriver,
	RuntimeDriverFactory,
	RuntimeDriverOptions,
	SharedRuntimeDriver,
	SystemDriver,
} from "@firestart/secure-exec-core";
