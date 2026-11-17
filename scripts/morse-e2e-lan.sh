#!/usr/bin/env bash
# Morse "own devices are owner + LAN first" acceptance (ADR-034), on ONE machine, isolated:
#   - the Cloudflare relay under `wrangler dev` (local workerd + simulated KV / Durable
#     Objects; XDG_CONFIG_HOME → a temp dir: your real wrangler login is never read,
#     nothing is deployed);
#   - every computer is a throw-away HOME (HOME=MORSE_HOME=<tmp>) with its own ports.
#     Daemons run WITH the LAN layer (real mDNS), under device names that cannot clash
#     with real computers (e2e-lan-<role>-<random>), and are all stopped at the end.
# People: mei with two computers (agents mini / air), bob with one.
# Checks: mini and air pair each other as OWNER; bob and mei are PEER both ways;
# mini → morse.im/mei/air goes over the LAN (log: "delivered via lan"); bob may use
# the LAN too and stays peer (labelled); with air's LAN listener gone (air restarted with
# --no-lan) the next message goes through the relay (log: "via relay").
# Never touches the real HOME, ~/Library/LaunchAgents, or relay.morse.im / relay.morse.talk.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$PWD
CLI="node $REPO/dist/cli.js"
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/morse-e2e-lan.XXXXXX")
HADM=$ROOT/admin HM=$ROOT/mei-mini HAIR=$ROOT/mei-air HB=$ROOT/bob
mkdir -p "$HADM" "$HM" "$HAIR" "$HB" "$ROOT/xdg" "$ROOT/cf-state"
RELAY_PORT=${RELAY_PORT:-18907}
PM=17811 PAIR=17821 PB=17831
RELAY=ws://127.0.0.1:$RELAY_PORT
ADMIN=e2e-admin-$RANDOM$RANDOM
TAG=$RANDOM
NM=e2e-lan-mini-$TAG NAIR=e2e-lan-air-$TAG NB=e2e-lan-bob-$TAG
WRANGLER=$REPO/relay-cf/node_modules/.bin/wrangler
PIDS=()
stop_port() {
  pkill -TERM -f "wrangler.*persist-to $ROOT" 2>/dev/null || true
  for _ in $(seq 1 50); do lsof -ti "tcp:$1" -sTCP:LISTEN >/dev/null 2>&1 || return 0; sleep 0.2; done
  local pids; pids=$(lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null || true); [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
}
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; stop_port "$RELAY_PORT"; wait 2>/dev/null || true; }
trap cleanup EXIT

as() { local h=$1; shift; HOME=$h MORSE_HOME=$h $CLI "$@"; }
pass() { echo "  PASS: $*"; }
fail() { echo "  FAIL: $*"; echo "  (logs in $ROOT)"; exit 1; }
wait_for() { local t=$1; shift; for _ in $(seq 1 $((t * 5))); do if "$@" >/dev/null 2>&1; then return 0; fi; sleep 0.2; done; return 1; }
start_daemon() { # start_daemon <home> <port> <log> [extra args] → $LASTPID
  local h=$1 port=$2 log=$3; shift 3
  for p in "$port" "$((port + 1))"; do lsof -ti "tcp:$p" -sTCP:LISTEN >/dev/null 2>&1 && fail "port $p is in use"; done
  HOME=$h MORSE_HOME=$h $CLI start --no-notify --port "$port" "$@" >>"$log" 2>&1 &
  LASTPID=$!
  PIDS+=($LASTPID)
}
invite() { HOME=$HADM MORSE_HOME=$HADM MORSE_ADMIN_KEY=$ADMIN $CLI invite "$@" --relay "$RELAY"; }
code_of() { awk '/^code:/{print $2}'; }
fast_retry() { python3 - "$1/.morse/config.json" <<'PY'
import json,sys; p=sys.argv[1]
try: c=json.load(open(p))
except FileNotFoundError: c={}
c['outbox']={'retryIntervalSec':3,'maxWaitDays':30}
# strangers "accept" (pairs at once, the pre-ADR-037 behaviour): this script is not about
# message requests — scripts/morse-e2e-requests.sh covers those
c.setdefault('morse',{})['strangers']='accept'; c.setdefault('plugins',{}).setdefault('attendant',{})['enabled']=False  # ADR-066: no real agent answers in e2e
json.dump(c,open(p,'w'),indent=2)
PY
}
send_from() { as "$1" send "$3" "$4" --port "$2" | tee -a "$ROOT/sends.log" | awk '/^queued/{print $2}'; }
# the via of the received message containing <marker> on <home> (morse-lan / morse-relay)
via_of() { HOME=$1 MORSE_HOME=$1 $CLI inbox --all --json | python3 -c "import json,sys; m=[m for m in json.load(sys.stdin) if '$2' in m['parts'][0]['text'] and m['parts'][0].get('via','').startswith('morse-') and m['parts'][0].get('via')!='morse-self']; print(m[0]['parts'][0]['via'] if m else '')"; }
arrived() { [ -n "$(via_of "$1" "$2")" ]; }
tier_of() { as "$1" pair list | awk -v id="$2" '$2==id {for(i=1;i<=NF;i++) if($i=="tier:") print $(i+1)}'; }
id_of() { as "$1" relay show | awk '/^device:/{print $2}'; }

echo "== setup in $ROOT (device names: $NM $NAIR $NB)"
npm run build >/dev/null
test -x "$WRANGLER" || (cd relay-cf && npm install --no-audit --no-fund >/dev/null)
lsof -ti "tcp:$RELAY_PORT" -sTCP:LISTEN >/dev/null 2>&1 && fail "port $RELAY_PORT is in use (set RELAY_PORT)"
( cd relay-cf && XDG_CONFIG_HOME=$ROOT/xdg WRANGLER_SEND_METRICS=false CLOUDFLARE_API_TOKEN= CLOUDFLARE_ACCOUNT_ID= \
    "$WRANGLER" dev --port "$RELAY_PORT" --inspector-port 0 --persist-to "$ROOT/cf-state" --log-level log --var "ADMIN_KEY:$ADMIN" >"$ROOT/relay.log" 2>&1 ) &
PIDS+=($!)
wait_for 60 curl -sf "http://127.0.0.1:$RELAY_PORT/healthz" || fail "relay did not come up (see $ROOT/relay.log)"
pass "relay up (wrangler dev, isolated XDG_CONFIG_HOME)"

echo "== 1. mei joins two computers (mini / air), bob one"
CY=$(invite create mei --uses 2 | code_of)
CB=$(invite create bob | code_of)
as "$HM" join "$CY" --relay "$RELAY" --name "$NM" --agent mini | sed 's/^/   mini: /'
as "$HAIR" join "$CY" --relay "$RELAY" --name "$NAIR" --agent air | sed 's/^/   air:  /'
as "$HB" join "$CB" --relay "$RELAY" --name "$NB" --agent bob-mbp | sed 's/^/   bob:  /'
ID_M=$(id_of "$HM") ID_AIR=$(id_of "$HAIR") ID_B=$(id_of "$HB")
[ -n "$ID_M" ] && [ -n "$ID_AIR" ] && [ -n "$ID_B" ] || fail "could not read device IDs"
pass "joined"

echo "== 2. daemons up WITH the LAN layer (mDNS), all three discover each other"
for h in "$HM" "$HAIR" "$HB"; do fast_retry "$h"; done
start_daemon "$HM" $PM "$ROOT/mini.log"
start_daemon "$HAIR" $PAIR "$ROOT/air.log"; AIRPID=$LASTPID
start_daemon "$HB" $PB "$ROOT/bob.log"
for l in mini air bob; do wait_for 20 grep -q "relay: connected" "$ROOT/$l.log" || fail "$l did not connect"; done
grep -h "^lan: device" "$ROOT"/mini.log "$ROOT"/air.log "$ROOT"/bob.log | sed 's/^/   /'
wait_for 30 sh -c "HOME=$HM MORSE_HOME=$HM $CLI peers --port $PM | grep -q '$NAIR'" || fail "mini did not discover air over mDNS"
wait_for 30 sh -c "HOME=$HB MORSE_HOME=$HB $CLI peers --port $PB | grep -q '$NAIR'" || fail "bob did not discover air over mDNS"
pass "mDNS discovery between the test daemons"

echo "== 3. first contact mini → mei/air: mini and air pair each other as OWNER"
M0=$(send_from "$HM" $PM morse.im/mei/air "L0 first contact mini to air")
wait_for 25 arrived "$HAIR" L0 || fail "L0 did not reach air"
for _ in $(seq 1 25); do [ "$(tier_of "$HAIR" "$ID_M")" = owner ] && break; sleep 0.2; done
T1=$(tier_of "$HM" "$ID_AIR"); T2=$(tier_of "$HAIR" "$ID_M")
echo "   mini trusts air: $T1 · air trusts mini: $T2"
[ "$T1" = owner ] && [ "$T2" = owner ] || fail "own devices are not owner (mini→air: $T1, air→mini: $T2)"
grep "${M0:0:8}" "$ROOT/mini.log" | sed 's/^/   mini.log: /'
pass "same handle → owner on both sides"

echo "== 4. mini → morse.im/mei/air goes over the LAN"
M1=$(send_from "$HM" $PM morse.im/mei/air "L1 mini to air on the LAN")
wait_for 25 arrived "$HAIR" L1 || fail "L1 did not reach air"
grep "${M1:0:8}" "$ROOT/mini.log" | sed 's/^/   mini.log: /'
grep -q "${M1:0:8} → morse.im/mei/air delivered via lan" "$ROOT/mini.log" || fail "L1 did not go via lan"
[ "$(via_of "$HAIR" L1)" = morse-lan ] || fail "air filed L1 as $(via_of "$HAIR" L1), not morse-lan"
as "$HAIR" inbox | grep -A1 "L1 mini" | sed 's/^/   air inbox: /'
as "$HAIR" inbox | grep -A1 "L1 mini" | grep -q "同伴消息" && fail "an owner message is labelled as a peer message"
M1R=$(send_from "$HAIR" $PAIR morse.im/mei/mini "L2 air to mini on the LAN")
wait_for 25 arrived "$HM" L2 || fail "L2 did not reach mini"
grep -q "${M1R:0:8} → morse.im/mei/mini delivered via lan" "$ROOT/air.log" || fail "L2 did not go via lan"
pass "own devices: direct over the LAN both ways, owner (no peer label)"

echo "== 5. bob ↔ mei are PEER; bob may use the LAN too, still peer"
B0=$(send_from "$HB" $PB morse.im/mei/air "P0 bob first contact")
wait_for 25 arrived "$HAIR" P0 || fail "P0 did not reach air"
B1=$(send_from "$HB" $PB morse.im/mei/air "P1 bob to air")
wait_for 25 arrived "$HAIR" P1 || fail "P1 did not reach air"
grep -E "${B0:0:8}|${B1:0:8}" "$ROOT/bob.log" | sed 's/^/   bob.log: /'
grep -q "${B1:0:8} → morse.im/mei/air delivered via lan" "$ROOT/bob.log" || fail "P1 (peer) did not go via lan"
T3=$(tier_of "$HB" "$ID_AIR"); T4=$(tier_of "$HAIR" "$ID_B")
echo "   bob trusts air: $T3 · air trusts bob: $T4"
[ "$T3" = peer ] && [ "$T4" = peer ] || fail "bob ↔ mei should be peer (bob→air: $T3, air→bob: $T4)"
as "$HAIR" inbox | grep -A1 "P1 bob" | grep -q "同伴消息" || fail "bob's message is not labelled as a peer message"
pass "bob ↔ mei peer both ways; LAN delivery keeps the peer label"

echo "== 6. air's LAN listener stopped (restart with --no-lan): mini → air goes through the relay"
kill "$AIRPID"; wait "$AIRPID" 2>/dev/null || true
start_daemon "$HAIR" $PAIR "$ROOT/air2.log" --no-lan
wait_for 20 grep -q "relay: connected" "$ROOT/air2.log" || fail "air did not reconnect"
lsof -ti "tcp:$((PAIR + 1))" -sTCP:LISTEN >/dev/null 2>&1 && fail "air's LAN port is still listening"
M3=$(send_from "$HM" $PM morse.im/mei/air "L3 mini to air without LAN")
wait_for 25 arrived "$HAIR" L3 || fail "L3 did not reach air"
grep "${M3:0:8}" "$ROOT/mini.log" | sed 's/^/   mini.log: /'
grep -q "${M3:0:8} → morse.im/mei/air delivered via relay" "$ROOT/mini.log" || fail "L3 did not go via relay"
[ "$(via_of "$HAIR" L3)" = morse-relay ] || fail "air filed L3 as $(via_of "$HAIR" L3)"
pass "no LAN listener → relay (logged)"

echo "== 7. stop every test process"
cleanup
trap - EXIT
sleep 1
for p in $PM $PAIR $PB; do pgrep -f "dist/cli.js start --no-notify --port $p" >/dev/null && fail "the test daemon on port $p is still running"; done
for p in $PM $((PM + 1)) $PAIR $((PAIR + 1)) $PB $((PB + 1)) $RELAY_PORT; do lsof -ti "tcp:$p" -sTCP:LISTEN >/dev/null 2>&1 && fail "port $p still has a listener"; done
pgrep -f "persist-to $ROOT" >/dev/null && fail "wrangler dev is still running"
pass "no test process left"
echo "== ALL CHECKS PASSED (logs in $ROOT)"
