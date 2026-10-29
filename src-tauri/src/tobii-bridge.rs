#[path = "tobii.rs"]
mod tobii;

use serde::Deserialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tiny_http::{Header, Method, Request, Response, Server};

const ADDRESS: &str = "127.0.0.1:17343";
const ORIGINS: [&str; 2] = ["https://ian030590.github.io", "http://127.0.0.1:4173"];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Command {
    command: String,
    client_id: String,
    #[serde(default)]
    session_id: u32,
}

struct Lease {
    client: String,
    session: u32,
    last_read: Instant,
}

fn header(request: &Request, name: &'static str) -> String {
    request.headers().iter().find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str().to_owned()).unwrap_or_default()
}

fn reply(request: Request, status: u16, body: Value, origin: &str) {
    let mut response = Response::from_string(body.to_string()).with_status_code(status);
    for (name, value) in [
        ("Content-Type", "application/json"),
        ("Cache-Control", "no-store"),
        ("Vary", "Origin"),
        ("Access-Control-Allow-Origin", origin),
        ("Access-Control-Allow-Methods", "POST, OPTIONS"),
        ("Access-Control-Allow-Headers", "Content-Type"),
        ("Access-Control-Allow-Private-Network", "true"),
    ] {
        if let Ok(h) = Header::from_bytes(name, value) { response.add_header(h); }
    }
    let _ = request.respond(response);
}

fn execute(command: Command, manager: &tobii::TobiiManager, lease: &mut Option<Lease>) -> Result<Value, String> {
    if command.client_id.len() != 36 || !command.client_id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        return Err("Invalid client ID".into());
    }
    if command.command == "get_native_clock" {
        return Ok(json!({ "timestampUs": manager.get_monotonic_clock_us() }));
    }
    if command.session_id == 0 { return Err("Invalid session".into()); }
    if let Some(active) = lease.as_ref() {
        if active.client != command.client_id || (command.command != "start_tobii" && active.session != command.session_id) {
            return Err("Tobii is in use by another session. Close the other game window first.".into());
        }
    } else if command.command != "start_tobii" {
        return Err("Start a Tobii session first".into());
    }
    let data = match command.command.as_str() {
        "start_tobii" => {
            let snapshot = manager.start(command.session_id)?;
            *lease = Some(Lease { client: command.client_id, session: command.session_id, last_read: Instant::now() });
            json!(snapshot)
        }
        "read_tobii_snapshot" => json!(manager.read(command.session_id)),
        "read_tobii_device" => json!(manager.device(command.session_id)),
        "stop_tobii" => {
            manager.stop(command.session_id);
            *lease = None;
            Value::Null
        }
        _ => return Err("Unsupported command".into()),
    };
    if let Some(active) = lease.as_mut() { active.last_read = Instant::now(); }
    Ok(data)
}

fn handle(mut request: Request, manager: &tobii::TobiiManager, lease: &mut Option<Lease>) {
    let origin = header(&request, "Origin");
    if header(&request, "Host") != ADDRESS || !ORIGINS.contains(&origin.as_str()) {
        reply(request, 403, json!({ "error": "Origin or host not allowed" }), "null");
        return;
    }
    if request.url() != "/command" {
        reply(request, 404, json!({ "error": "Not found" }), &origin);
        return;
    }
    if request.method() == &Method::Options {
        reply(request, 204, Value::Null, &origin);
        return;
    }
    if request.method() != &Method::Post || header(&request, "Content-Type") != "application/json"
        || !request.body_length().is_some_and(|length| length > 0 && length <= 4096) {
        reply(request, 400, json!({ "error": "Expected a JSON POST of at most 4096 bytes" }), &origin);
        return;
    }
    let command = serde_json::from_reader::<_, Command>(request.as_reader());
    let result = command.map_err(|e| e.to_string()).and_then(|command| execute(command, manager, lease));
    match result {
        Ok(data) => reply(request, 200, data, &origin),
        Err(error) => reply(request, 400, json!({ "error": error }), &origin),
    }
}

fn main() {
    let server = match Server::http(ADDRESS) {
        Ok(server) => server,
        Err(error) => {
            eprintln!("Cannot start Tobii bridge on {ADDRESS}: {error}\nPress Enter to close.");
            let _ = std::io::stdin().read_line(&mut String::new());
            return;
        }
    };
    println!("FlyingMoo Tobii bridge v{}\nOpen https://ian030590.github.io/FlyingMoo/ and select Tobii.\nKeep this window open. Close it or press Ctrl+C to stop.\nOnly loopback connections from the FlyingMoo site are accepted.", env!("CARGO_PKG_VERSION"));
    let manager = tobii::TobiiManager::new();
    let mut lease: Option<Lease> = None;
    loop {
        if lease.as_ref().is_some_and(|active| active.last_read.elapsed() > Duration::from_secs(5)) {
            manager.stop(0);
            lease = None;
        }
        match server.recv_timeout(Duration::from_millis(250)) {
            Ok(Some(request)) => handle(request, &manager, &mut lease),
            Ok(None) => (),
            Err(error) => { eprintln!("Bridge stopped: {error}"); break; }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_reject_invalid_clients_and_cannot_control_other_sessions() {
        let manager = tobii::TobiiManager::new();
        let mut lease = Some(Lease { client: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa".into(), session: 7, last_read: Instant::now() });
        for (client, session, action) in [
            ("invalid", 7, "start_tobii"),
            ("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", 7, "start_tobii"),
            ("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", 8, "stop_tobii"),
            ("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", 0, "read_tobii_snapshot"),
            ("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", 7, "start_recording"),
        ] {
            assert!(execute(Command { client_id: client.into(), session_id: session, command: action.into() }, &manager, &mut lease).is_err());
        }
        assert_eq!(lease.unwrap().session, 7);
    }
}
