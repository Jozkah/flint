// The remote-access wire protocol, shared by the desktop bridge and the phone
// client. The desktop's Rust server (src-tauri/src/core/remote) forwards a
// phone's `POST /remote/v1/rpc` body to the window as a `remote://rpc` event
// and returns whatever the bridge answers; events travel the other way over
// the `/remote/v1/events` WebSocket.
//
// Kept free of app imports so the phone bundle can use it as is.

export * from './protocolTypes'
export * from './protocolRequests'
export * from './protocolEvents'
