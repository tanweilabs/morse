#!/usr/bin/env bash
# Morse "every contact by its address" acceptance (ADR-091, stage 2), on ONE machine, isolated:
#   - the Cloudflare relay under `wrangler dev` (local workerd + simulated KV / Durable Objects;
#     XDG_CONFIG_HOME → a temp dir: your real wrangler login is never read, nothing is deployed);
#   - two computers, each a throw-away home (MORSE_HOME=<tmp>/x, HOME=<tmp>/x/home) on its own ports
#     (17901 / 17911, the LAN listener on the next port), with the LAN layer by address turned on (`--lan`: it is off
#     by default since the ADR-091 follow-up; real mDNS,
#     _morse._tcp) — or, with LAN_STATIC=1, the other one named with --peer instead of mDNS.
# Checks: each gets an address with `morse address` (no old name, nothing asked of the relay); each adds
# the other with `morse contact add morse.im/<address>`; a → b and b → a go over the LAN (log: "delivered
# via lan"); with b's LAN listener gone (b restarted with --no-lan) the next message goes by the next path
# (WebRTC direct when node-datachannel is there, else the relay).
# Never touches the real HOME, ~/.morse, the real launchd job, or relay.morse.im.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$PWD
CLI="node $REPO/dist/cli.js"
if env | grep -iE '^(MORSE|ANYTOANY)' >/dev/null; then echo "refusing to run: MORSE_* / ANYTOANY_* is set in this shell" >&2; exit 1; fi
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/morse-e2e-addresses.XXXXXX")
HA=$ROOT/a HB=$ROOT/b
mkdir -p "$HA/home" "$HB/home" "$ROOT/xdg" "$ROOT/cf-state"
RELAY_PORT=${RELAY_PORT:-17990}
PA=17901 PB=17911
RELAY=ws://127.0.0.1:$RELAY_PORT
WRANGLER=$REPO/relay-cf/node_modules/.bin/wrangler
PIDS=()
stop_port() {
  pkill -TERM -f "wrangler.*persist-to $ROOT" 2>/dev/null || true
  for _ in $(seq 1 50); do lsof -ti "tcp:$1" -sTCP:LISTEN >/dev/null 2>&1 || return 0; sleep 0.2; done
  local pids; pids=$(lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null || true); [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
}
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; stop_port "$RELAY_PORT"; wait 2>/dev/null || true; }
trap cleanup EXIT

as() { local h=$1; shift; HOME=$h/home MORSE_HOME=$h $CLI "$@"; }
pass() { echo "  PASS: $*"; }
fail() { echo "  FAIL: $*"; echo "  (logs in $ROOT)"; exit 1; }
wait_for() { local t=$1; shift; for _ in $(seq 1 $((t * 5))); do if "$@" >/dev/null 2>&1; then return 0; fi; sleep 0.2; done; return 1; }
listener_is() { [ "$(lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null | head -1)" = "$2" ]; }
start_daemon() { # start_daemon <home> <port> <log> [extra args] → $LASTPID; the console and LAN listeners must be this process's
  local h=$1 port=$2 log=$3; shift 3
  for p in "$port" "$((port + 1))"; do lsof -ti "tcp:$p" -sTCP:LISTEN >/dev/null 2>&1 && fail "port $p is in use"; done
  HOME=$h/home MORSE_HOME=$h $CLI start --no-notify --port "$port" "$@" >>"$log" 2>&1 &
  LASTPID=$!
  PIDS+=($LASTPID)
  wait_for 30 listener_is "$port" "$LASTPID" || fail "port $port is not this daemon's (pid $LASTPID; see $log)"
}
configure() { python3 - "$1/.morse/config.json" "$RELAY" <<'PY'
import json,os,sys; p,relay=sys.argv[1],sys.argv[2]
os.makedirs(os.path.dirname(p),exist_ok=True)
try: c=json.load(open(p))
except FileNotFoundError: c={}
c.setdefault('relay',{})['url']=relay
c['outbox']={'retryIntervalSec':3,'maxWaitDays':30}
c['update']={'auto':False}
c.setdefault('plugins',{}).setdefault('attendant',{})['enabled']=False  # no real agent answers in e2e
c['plugins'].setdefault('dispatch',{})['enabled']=False
json.dump(c,open(p,'w'),indent=2)
PY
}
address_of() { as "$1" address | awk '/^address:/{print $2; exit}'; }
in_log() { grep -q -- "$2" "$1"; }

echo "== setup in $ROOT"
npm run build >/dev/null
test -x "$WRANGLER" || (cd relay-cf && npm install --no-audit --no-fund >/dev/null)
lsof -ti "tcp:$RELAY_PORT" -sTCP:LISTEN >/dev/null 2>&1 && fail "port $RELAY_PORT is in use (set RELAY_PORT)"
( cd relay-cf && XDG_CONFIG_HOME=$ROOT/xdg WRANGLER_SEND_METRICS=false CLOUDFLARE_API_TOKEN= CLOUDFLARE_ACCOUNT_ID= \
    "$WRANGLER" dev --port "$RELAY_PORT" --inspector-port 0 --persist-to "$ROOT/cf-state" --log-level log >"$ROOT/relay.log" 2>&1 ) &
PIDS+=($!)
wait_for 60 curl -sf "http://127.0.0.1:$RELAY_PORT/healthz" || fail "relay did not come up (see $ROOT/relay.log)"
pass "relay up (wrangler dev on 127.0.0.1:$RELAY_PORT, isolated XDG_CONFIG_HOME)"

echo "== 1. each computer gets its own address; they add each other by address"
for h in "$HA" "$HB"; do configure "$h"; as "$h" address >>"$ROOT/setup.log" 2>&1 || fail "morse address failed (see $ROOT/setup.log)"; done
A=$(address_of "$HA"); B=$(address_of "$HB")
[[ "$A" =~ ^morse\.im/[23456789abcdefghjkmnpqrstvwxyz]{26}$ ]] || fail "a has no address ($A)"
[[ "$B" =~ ^morse\.im/[23456789abcdefghjkmnpqrstvwxyz]{26}$ ]] || fail "b has no address ($B)"
as "$HA" address | grep -q 'old name' && fail "an old name is shown"
as "$HA" contact add "$B" --name bee >>"$ROOT/setup.log" || fail "a could not add b"
as "$HB" contact add "$A" --name ay >>"$ROOT/setup.log" || fail "b could not add a"
out=$(as "$HA" contact add morse.im/somebody 2>&1 || true)
echo "$out" | grep -q 'old names no longer work' || fail "an old name was not refused: $out"
pass "a = $A, b = $B; contacts by address; an old name refused in one line"

echo "== 2. both daemons up, LAN by address"
PEER_A=() PEER_B=()
if [ "${LAN_STATIC:-}" = 1 ]; then PEER_A=(--peer "${B#morse.im/}@127.0.0.1:$((PB + 1))"); PEER_B=(--peer "${A#morse.im/}@127.0.0.1:$((PA + 1))"); fi
start_daemon "$HA" "$PA" "$ROOT/a.log" --lan "${PEER_A[@]+"${PEER_A[@]}"}"; PIDA=$LASTPID
start_daemon "$HB" "$PB" "$ROOT/b.log" --lan "${PEER_B[@]+"${PEER_B[@]}"}"; PIDB=$LASTPID
wait_for 30 listener_is "$((PA + 1))" "$PIDA" || fail "a's LAN listener is not on $((PA + 1))"
wait_for 30 listener_is "$((PB + 1))" "$PIDB" || fail "b's LAN listener is not on $((PB + 1))"
wait_for 30 in_log "$ROOT/a.log" 'v3 connected' || fail "a did not connect (see $ROOT/a.log)"
wait_for 30 in_log "$ROOT/b.log" 'v3 connected' || fail "b did not connect (see $ROOT/b.log)"
in_log "$ROOT/a.log" 'lan: by address on' || fail "a has no LAN layer"
pass "daemons up on $PA / $PB (LAN on $((PA + 1)) / $((PB + 1))), both listeners checked to be ours$([ "${LAN_STATIC:-}" = 1 ] && echo ' — LAN peers given with --peer, no mDNS' || echo ' — mDNS _morse._tcp')"

echo "== 3. a → b and b → a over the LAN"
sleep 3 # mDNS: the other one is found
as "$HA" send bee "e2e-lan-1 from a" --port "$PA" >>"$ROOT/sends.log" || fail "a could not queue"
wait_for 30 in_log "$ROOT/a.log" "→ $B delivered via lan" || fail "a → b did not go over the LAN (see $ROOT/a.log)"
wait_for 10 in_log "$ROOT/b.log" "via lan" || fail "b did not log a LAN arrival"
pass "a → b delivered via lan (b proved its address to a first)"
as "$HB" send ay "e2e-lan-2 from b" --port "$PB" >>"$ROOT/sends.log" || fail "b could not queue"
wait_for 30 in_log "$ROOT/b.log" "→ $A delivered via lan" || fail "b → a did not go over the LAN (see $ROOT/b.log)"
pass "b → a delivered via lan"
as "$HB" read --json >"$ROOT/b-read.json"
grep -q 'e2e-lan-1 from a' "$ROOT/b-read.json" || fail "b's inbox does not have a's message"
as "$HA" read --json >"$ROOT/a-read.json"
grep -q 'e2e-lan-2 from b' "$ROOT/a-read.json" || fail "a's inbox does not have b's message"
pass "both messages are in the inboxes"

echo "== 4. b without the LAN: the next path carries it"
kill "$PIDB"; wait "$PIDB" 2>/dev/null || true
for _ in $(seq 1 50); do lsof -ti "tcp:$PB" -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.2; done
start_daemon "$HB" "$PB" "$ROOT/b2.log" --no-lan
wait_for 30 in_log "$ROOT/b2.log" 'v3 connected' || fail "b did not reconnect (see $ROOT/b2.log)"
as "$HA" send bee "e2e-relay-3 from a" --port "$PA" >>"$ROOT/sends.log" || fail "a could not queue"
in_log_re() { grep -qE -- "$2" "$1"; }
wait_for 60 in_log_re "$ROOT/a.log" "→ $B delivered via (direct|relay)" || fail "a → b did not fall back off the LAN (see $ROOT/a.log)"
pass "a → b $(grep -oE "→ $B delivered via (direct|relay)" "$ROOT/a.log" | tail -1 | sed 's/.*delivered //') (no LAN: WebRTC direct when it opens, else the relay)"

echo "== all passed (logs in $ROOT)"
