#!/usr/bin/env bash
# Morse "first contact goes over the LAN" acceptance (ADR-034 follow-up), on ONE machine, isolated:
#   - the Cloudflare relay under `wrangler dev` (local workerd + simulated KV / Durable
#     Objects; XDG_CONFIG_HOME → a temp dir: your real wrangler login is never read,
#     nothing is deployed);
#   - every computer is a throw-away HOME (HOME=MORSE_HOME=<tmp>) with its own ports.
#     Daemons run WITH the LAN layer (real mDNS), under device names that cannot clash
#     with real computers (e2e-lan-<role>-<random>), and are all stopped at the end.
# People: alice and bob, one computer each, two different handles, never paired.
# Checks: bob's VERY FIRST message to morse.im/alice goes over the LAN (alice confirms
# bob with the relay directory and pairs him as peer on the spot); nobody logs "not
# paired" or "anyd"; alice's reply goes over the LAN too; both sides are peer.
# Never touches the real HOME, ~/Library/LaunchAgents, or relay.morse.im / relay.morse.talk.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$PWD
CLI="node $REPO/dist/cli.js"
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/morse-e2e-lan-first.XXXXXX")
HADM=$ROOT/admin HA=$ROOT/alice HB=$ROOT/bob
mkdir -p "$HADM" "$HA" "$HB" "$ROOT/xdg" "$ROOT/cf-state"
RELAY_PORT=${RELAY_PORT:-18927}
PA=17851 PB=17861
RELAY=ws://127.0.0.1:$RELAY_PORT
ADMIN=e2e-admin-$RANDOM$RANDOM
TAG=$RANDOM
NA=e2e-lanfirst-alice-$TAG NB=e2e-lanfirst-bob-$TAG
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

echo "== setup in $ROOT (device names: $NA $NB)"
npm run build >/dev/null
test -x "$WRANGLER" || (cd relay-cf && npm install --no-audit --no-fund >/dev/null)
lsof -ti "tcp:$RELAY_PORT" -sTCP:LISTEN >/dev/null 2>&1 && fail "port $RELAY_PORT is in use (set RELAY_PORT)"
( cd relay-cf && XDG_CONFIG_HOME=$ROOT/xdg WRANGLER_SEND_METRICS=false CLOUDFLARE_API_TOKEN= CLOUDFLARE_ACCOUNT_ID= \
    "$WRANGLER" dev --port "$RELAY_PORT" --inspector-port 0 --persist-to "$ROOT/cf-state" --log-level log --var "ADMIN_KEY:$ADMIN" >"$ROOT/relay.log" 2>&1 ) &
PIDS+=($!)
wait_for 60 curl -sf "http://127.0.0.1:$RELAY_PORT/healthz" || fail "relay did not come up (see $ROOT/relay.log)"
pass "relay up (wrangler dev, isolated XDG_CONFIG_HOME)"

echo "== 1. alice and bob join (two handles, one computer each)"
CA=$(invite create alice | code_of)
CB=$(invite create bob | code_of)
as "$HA" join "$CA" --relay "$RELAY" --name "$NA" --agent alice-mbp | sed 's/^/   alice: /'
as "$HB" join "$CB" --relay "$RELAY" --name "$NB" --agent bob-mbp | sed 's/^/   bob:   /'
ID_A=$(id_of "$HA") ID_B=$(id_of "$HB")
[ -n "$ID_A" ] && [ -n "$ID_B" ] || fail "could not read device IDs"
[ -z "$(tier_of "$HA" "$ID_B")" ] && [ -z "$(tier_of "$HB" "$ID_A")" ] || fail "alice and bob should not be paired yet"
pass "joined, not paired with each other"

echo "== 2. daemons up WITH the LAN layer (mDNS), they discover each other"
for h in "$HA" "$HB"; do fast_retry "$h"; done
start_daemon "$HA" $PA "$ROOT/alice.log"
start_daemon "$HB" $PB "$ROOT/bob.log"
for l in alice bob; do wait_for 20 grep -q "relay: connected" "$ROOT/$l.log" || fail "$l did not connect"; done
grep -h "^lan: device" "$ROOT"/alice.log "$ROOT"/bob.log | sed 's/^/   /'
wait_for 30 sh -c "HOME=$HB MORSE_HOME=$HB $CLI peers --port $PB | grep -q '$NA'" || fail "bob did not discover alice over mDNS"
wait_for 30 sh -c "HOME=$HA MORSE_HOME=$HA $CLI peers --port $PA | grep -q '$NB'" || fail "alice did not discover bob over mDNS"
pass "mDNS discovery between the test daemons"

echo "== 3. bob's FIRST message to morse.im/alice goes over the LAN"
B0=$(send_from "$HB" $PB morse.im/alice "F0 bob first contact with alice")
wait_for 25 arrived "$HA" F0 || fail "F0 did not reach alice"
grep "${B0:0:8}" "$ROOT/bob.log" | sed 's/^/   bob.log:   /'
grep -E "auto-paired|${B0:0:8}" "$ROOT/alice.log" | sed 's/^/   alice.log: /'
grep -q "${B0:0:8} → morse.im/alice/alice-mbp delivered via lan" "$ROOT/bob.log" || fail "F0 did not go via lan"
[ "$(via_of "$HA" F0)" = morse-lan ] || fail "alice filed F0 as $(via_of "$HA" F0), not morse-lan"
grep -q "lan: auto-paired morse.im/bob .*tier peer) — they messaged you first over the LAN" "$ROOT/alice.log" || fail "alice did not log the LAN auto-pair"
as "$HA" inbox | grep -A1 "F0 bob" | grep -q "同伴消息" || fail "bob's message is not labelled as a peer message"
pass "first message direct over the LAN, labelled peer"

echo "== 4. alice replies: over the LAN too"
A1=$(send_from "$HA" $PA morse.im/bob "F1 alice replies")
wait_for 25 arrived "$HB" F1 || fail "F1 did not reach bob"
grep "${A1:0:8}" "$ROOT/alice.log" | sed 's/^/   alice.log: /'
grep -q "${A1:0:8} → morse.im/bob/bob-mbp delivered via lan" "$ROOT/alice.log" || fail "F1 did not go via lan"
T1=$(tier_of "$HA" "$ID_B"); T2=$(tier_of "$HB" "$ID_A")
echo "   alice trusts bob: $T1 · bob trusts alice: $T2"
[ "$T1" = peer ] && [ "$T2" = peer ] || fail "alice ↔ bob should be peer (alice→bob: $T1, bob→alice: $T2)"
pass "reply over the LAN; peer both ways"

echo "== 5. no 'not paired' / 'lan failed' / 'anyd' anywhere in the daemon logs"
if grep -nE "not paired|lan failed|\banyd\b|pairing request" "$ROOT/alice.log" "$ROOT/bob.log"; then fail "unexpected wording in the logs"; fi
pass "clean logs"

echo "== 6. stop every test process"
cleanup
trap - EXIT
sleep 1
for p in $PA $PB; do pgrep -f "dist/cli.js start --no-notify --port $p" >/dev/null && fail "the test daemon on port $p is still running"; done
for p in $PA $((PA + 1)) $PB $((PB + 1)) $RELAY_PORT; do lsof -ti "tcp:$p" -sTCP:LISTEN >/dev/null 2>&1 && fail "port $p still has a listener"; done
pgrep -f "persist-to $ROOT" >/dev/null && fail "wrangler dev is still running"
pass "no test process left"
echo "== ALL CHECKS PASSED (logs in $ROOT)"
