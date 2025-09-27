#!/bin/bash
set -euo pipefail
IFS=$'\n\t'

echo "[agent-sandbox] Initializing firewall (fail-closed)..."

# Clean filter table; do not touch NAT/MANGLE (leave Docker plumbing intact)
iptables -F || true
iptables -X || true

# Reset ipsets
ipset destroy allowed_nets 2>/dev/null || true
ipset destroy allowed_ips 2>/dev/null || true
ipset create allowed_nets hash:net -exist
ipset create allowed_ips  hash:ip  -exist

# Fetch GitHub meta information and aggregate + add their IP ranges
echo "Fetching GitHub IP ranges..."
gh_ranges=$(curl -s https://api.github.com/meta)
if [ -z "$gh_ranges" ]; then
    echo "ERROR: Failed to fetch GitHub IP ranges"
    exit 1
fi

if ! echo "$gh_ranges" | jq -e '.web and .api and .git' >/dev/null; then
    echo "ERROR: GitHub API response missing required fields"
    exit 1
fi

echo "Processing GitHub IPs..."
while read -r cidr; do
    if [[ ! "$cidr" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/[0-9]{1,2}$ ]]; then
        echo "ERROR: Invalid CIDR range from GitHub meta: $cidr"
        exit 1
    fi
    echo "Adding GitHub range $cidr to allowed_nets"
    ipset add allowed_nets "$cidr" 2>/dev/null || true
done < <(echo "$gh_ranges" | jq -r '(.web + .api + .git)[]' | aggregate -q)

# Build allowlist of domains (A records) for HTTPS egress
CONFIG_JSON="/.agent-sandbox/config.json"
BASE_DOMAINS=(
    "registry.npmjs.org"
    "openrouter.ai"
    "api.openai.com"
    "auth.openai.com"
    "chatgpt.com"
    "api.anthropic.com"
    "sentry.io"
    "statsig.anthropic.com"
    "statsig.com"
)
DOMAINS=("${BASE_DOMAINS[@]}")

if [ -r "$CONFIG_JSON" ]; then
    mapfile -t EXTRA_DOMAINS < <(jq -r '.egress_allow_domains[]? // empty' "$CONFIG_JSON" 2>/dev/null || true)
    if [ "${#EXTRA_DOMAINS[@]}" -gt 0 ]; then
        DOMAINS+=("${EXTRA_DOMAINS[@]}")
    fi
fi

for domain in "${DOMAINS[@]}"; do
    echo "Resolving $domain..."
    ips=$(dig +short A "$domain" | awk '/^([0-9]{1,3}\.){3}[0-9]{1,3}$/' | sort -u || true)

    # Fallback: use getent if dig produced nothing (e.g., DNS quirk)
    if [ -z "$ips" ]; then
        ips=$(getent ahostsv4 "$domain" | awk '{print $1}' | sort -u || true)
    fi

    if [ -z "$ips" ]; then
        echo "ERROR: Failed to resolve any IPv4 A records for $domain"
        exit 1
    fi

    while read -r ip; do
        # Validate IPv4; skip odd tokens without failing
        if [[ ! "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
            echo "Skipping non-IPv4 token for $domain: $ip"
            continue
        fi
        echo "Allowing $domain -> $ip"
        ipset add allowed_ips "$ip" 2>/dev/null || true
    done < <(echo "$ips")
done

# Default policies (fail-closed)
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP

# 1) Established/related first
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# 2) Loopback always
iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

# 3) DNS: allow resolvers from /etc/resolv.conf (fallback to 127.0.0.11)
mapfile -t RESOLVERS < <(awk '/^nameserver[[:space:]]+/ {print $2}' /etc/resolv.conf | tr -d '\r')
if [ "${#RESOLVERS[@]}" -eq 0 ]; then
    RESOLVERS=(127.0.0.11)
fi
for resolver in "${RESOLVERS[@]}"; do
    if [[ "$resolver" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
        echo "Allowing DNS resolver $resolver"
        iptables -A OUTPUT -p udp --dport 53 -d "$resolver" -j ACCEPT
        iptables -A OUTPUT -p tcp --dport 53 -d "$resolver" -j ACCEPT
    else
        echo "Skipping non-IPv4 DNS resolver $resolver"
    fi
done

# 4) Inbound ports (from .agent-sandbox/config.json: "ports": [<tcp>...])
if [ -r "$CONFIG_JSON" ]; then
    mapfile -t OPEN_PORTS < <(jq -r '.ports[]? // empty' "$CONFIG_JSON" 2>/dev/null || true)
    for port in "${OPEN_PORTS[@]}"; do
        if [[ "$port" =~ ^[0-9]+$ ]]; then
            echo "Opening inbound TCP port $port"
            iptables -A INPUT -p tcp --dport "$port" -m state --state NEW,ESTABLISHED -j ACCEPT
        fi
    done
fi

# 5) Outbound allowlists
#    - GitHub meta networks: TCP 22 (SSH) and 443 (HTTPS)
iptables -A OUTPUT -p tcp -m set --match-set allowed_nets dst --dport 22 -j ACCEPT
iptables -A OUTPUT -p tcp -m set --match-set allowed_nets dst --dport 443 -j ACCEPT
#    - Resolved IPs for domains: TCP 443 only
iptables -A OUTPUT -p tcp -m set --match-set allowed_ips dst --dport 443 -j ACCEPT

echo "Firewall configuration complete"
echo "Verifying firewall rules..."

# Negative probe must fail
curl_opts=(--fail --silent --show-error --ipv4 --connect-timeout 5 --max-time 10)

if curl "${curl_opts[@]}" https://example.com >/dev/null; then
    echo "ERROR: Firewall verification failed - unexpected access to https://example.com"
    exit 1
fi
echo "Negative probe passed (blocked example.com)."

# Positive probes (GitHub + primary providers)
probe_ok=1
curl "${curl_opts[@]}" https://api.github.com/zen >/dev/null || probe_ok=0
for d in "${DOMAINS[@]}"; do
    if ! curl "${curl_opts[@]}" "https://${d}" >/dev/null; then
        echo "WARN: Probe failed for https://${d}"
        probe_ok=0
    fi
done
if [ "$probe_ok" -ne 1 ]; then
    echo "ERROR: One or more required endpoints were not reachable through the allowlist."
    exit 1
fi
echo "Firewall verification passed - required endpoints reachable, others blocked."
