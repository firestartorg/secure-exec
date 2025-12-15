# lightweight sandbox

## overview

goal: design an emulated linux machine using WebAssembly.sh for Linux emulation and isolated-vm for the node emulation. thses are both bound to the same core "virtual machine" for filesystem & network & etc. this allows for emulating a linux environment without sacrificing performance (mostly, polyfills have some overhead) on the NodeJS app since it's in an isoalte.

the closest prior art is WebContainers, OpenWebContainers, and Nodebox. however, these all use web or WASM.

## project structure

- use typescript
- keep all in a single package in src/
- add a script check-types to check that types are working
- use vitest to test your work

loosely follow this structure, keep things simple:

```
src/
    vm/
        index.ts  # class VirtualMachine
        fs.ts  # class FileSystemManager
        ...etc...
    node-process/
        index.ts  # class NodeProcess (using isolated-vm)
        ...etc...
    wasix/
        index.ts  # class WasixInstance
        node-shim.ts  # handles shim between wasix <-> node-process (using isolated-vm)
    ...etc...
```

the end user api looks like:

```
const vm = new VirtualMachine("/path/to/local/fs");
const output = await vm.spawn("ls", ["/"]);
console.log('output', output.stdout, output.stderr, output.code)
```

by the end of this project, we should be able to do:

```
const shCode = `
    #!/bin/sh
    node script.js
`;

const jsCode = `
    const fs = require("fs");
    const path = require("path");

    // test ms package (simple, no deps)
    const ms = require("ms");
    console.log("1 hour in ms:", ms("1h"));

    // test jsonfile package (uses fs internally)
    const jsonfile = require("jsonfile");
    const testFile = "/test.json";
    jsonfile.writeFileSync(testFile, { hello: "world" });

`;

const fs = require("fs");

const vmPath = "/path/to/local/fs";
const vm = new VirtualMachine(vmPath);

// write scripts to the vm filesystem using native fs
fs.writeFileSync(`${vmPath}/test.sh`, shCode);
fs.writeFileSync(`${vmPath}/script.js`, jsCode);

// run the shell script (assumes npm install jsonfile ms was run on host)
const output = await vm.spawn("sh", ["/test.sh"]);
console.log('output', output.stdout, output.stderr, output.code)

// read back using native fs to verify
const raw = fs.readFileSync(`${vmPath}/test.json`, "utf8");
console.log("read back:", JSON.parse(raw));
```

## components

### virtual machine

this vm will be bound to BOTH the node shim. we only care about the file system for now, nothing else.

### node shim

runs Node.js code in an isolated-vm isolate. provides polyfilled node stdlib (fs, path, etc) and supports requiring packages from node_modules.

### wasix instance

uses WebAssembly.sh to emulate a Linux shell environment. provides shell commands (ls, cd, etc) and hooks into the node shim when running `node` commands.

## steps

1. implement a basic virtual machine with a fake file system. expose methods on this that forwards to a dedicated folder for this vm. keep this simple and add as needed.

```ts
import { VirtualMachine } from "./vm";
import fs from "fs";
import path from "path";
import os from "os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-test-"));
const vm = new VirtualMachine(tmpDir);

fs.writeFileSync(path.join(tmpDir, "hello.txt"), "world");
expect(vm.readFile("/hello.txt")).toBe("world");

vm.writeFile("/foo.txt", "bar");
expect(fs.readFileSync(path.join(tmpDir, "foo.txt"), "utf8")).toBe("bar");
```

2. get basic isolates & bindings working using isolated-vm

```ts
import { NodeProcess } from "./node-process";

const proc = new NodeProcess();
const result = await proc.run(`module.exports = 1 + 1`);
expect(result).toBe(2);
```

3. impl nodejs require with polyfill for node stdlib

```ts
import { NodeProcess } from "./node-process";

const proc = new NodeProcess();
const result = await proc.run(`
  const path = require("path");
  module.exports = path.join("foo", "bar");
`);
expect(result).toBe("foo/bar");
```

4. get basic wasix shell working

```ts
import { WasixInstance } from "./wasix";

const wasix = new WasixInstance();
const result = await wasix.exec("echo hello");
expect(result.stdout).toBe("hello\n");
```

5. get wasix file system bindings working (test ls, cd, etc)

```ts
import { VirtualMachine } from "./vm";
import { WasixInstance } from "./wasix";

const vm = new VirtualMachine(tmpDir);
const wasix = new WasixInstance(vm);

vm.writeFile("/test.txt", "content");
const result = await wasix.exec("ls /");
expect(result.stdout).toContain("test.txt");
```

6. implement package imports using the code in node_modules

```ts
import { VirtualMachine } from "./vm";
import { NodeProcess } from "./node-process";

const vm = new VirtualMachine(tmpDir);
// assume `npm install ms` was run in tmpDir on host
const proc = new NodeProcess(vm);
const result = await proc.run(`
  const ms = require("ms");
  module.exports = ms("1h");
`);
expect(result).toBe(3600000);
```

7. auto-install `node` program in wasix/webassembly.sh to kick out to the nodejs shim that will spawn the isolate

```ts
import { VirtualMachine } from "./vm";
import { WasixInstance } from "./wasix";

const vm = new VirtualMachine(tmpDir);
const wasix = new WasixInstance(vm);

vm.writeFile("/script.js", `console.log("hello from node")`);
const result = await wasix.exec("node /script.js");
expect(result.stdout).toBe("hello from node\n");
```

## future work

- terminal emulation
- get claude code cli working in this emulator
- emulate npm
- use node_modules instead of pulling packages from cdn

