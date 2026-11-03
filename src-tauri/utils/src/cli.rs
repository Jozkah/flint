/// Extracts the value of a command line argument flag from args vector
pub fn extract_arg_value(args: &[String], flag: &str) -> String {
    args.iter()
        .position(|arg| arg == flag)
        .and_then(|i| args.get(i + 1))
        .cloned()
        .unwrap_or_default()
}

/// Parses port from command line arguments with fallback to default (8080)
pub fn parse_port_from_args(args: &[String]) -> u16 {
    let port_str = extract_arg_value(args, "--port");
    match port_str.parse::<u16>() {
        Ok(p) => p,
        Err(_) => {
            eprintln!("Invalid port value: '{}', using default 8080", port_str);
            8080
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_valid_port() {
        assert_eq!(parse_port_from_args(&args(&["--port", "9000"])), 9000);
    }

    #[test]
    fn rejects_negative_and_oversized_ports() {
        assert_eq!(parse_port_from_args(&args(&["--port", "-1"])), 8080);
        assert_eq!(parse_port_from_args(&args(&["--port", "70000"])), 8080);
        assert_eq!(parse_port_from_args(&args(&[])), 8080);
    }
}
