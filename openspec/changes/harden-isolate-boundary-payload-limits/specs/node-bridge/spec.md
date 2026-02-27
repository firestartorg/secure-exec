## ADDED Requirements

### Requirement: Isolate Boundary Payload Transfers Are Size-Bounded
Bridge handlers that exchange serialized payloads between isolate and host MUST enforce maximum payload sizes before materializing or decoding untrusted data.

#### Scenario: Oversized binary read payload is rejected before host transfer
- **WHEN** `readFileBinaryRef` would return a base64 payload larger than the configured bridge transfer limit
- **THEN** the bridge MUST reject the request with a deterministic overflow error and MUST NOT return the oversized payload to the isolate

#### Scenario: Oversized binary write payload is rejected before decode
- **WHEN** `writeFileBinaryRef` receives a base64 payload larger than the configured bridge transfer limit
- **THEN** the bridge MUST reject the request before base64 decode and MUST NOT allocate a decoded buffer for the oversized payload

#### Scenario: Bridge JSON payloads are validated before parse
- **WHEN** host bridge code receives isolate-originated JSON text for a bridged operation
- **THEN** the runtime MUST validate payload size before `JSON.parse` and MUST reject oversized payloads with a deterministic overflow error
