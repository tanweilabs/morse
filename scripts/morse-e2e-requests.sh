#!/usr/bin/env bash
# Message requests (ADR-037) on ONE machine, fully isolated:
#   - the Cloudflare relay under `wrangler dev` (local workerd + simulated KV / DOs;
#     XDG_CONFIG_HOME → a temp dir: the real wrangler login is never read, nothing deployed);
#   - every computer is a throw-away HOME (HOME=MORSE_HOME=<tmp>) with its own ports,
#     device names e2e-req-*; part A runs --no-lan, part B WITH the LAN layer (real mDNS,
#     test devices only ever pair / talk to each other), and everything is stopped at the end.
# For both paths (A: relay, B: LAN):
#   1. bob sends alice 3 messages → alice: 1 request, 0 in the inbox (inbox/pull), the
#      inbox footer says so; bob: the first is "request pending", the rest are held;
#   2. alice `morse contact accept` → the request is in her inbox; bob is told and the
#      2 held messages arrive; bob's next message arrives normally; alice's reply reaches bob;
#   3. carol writes, alice `morse contact block` → carol's next message is dropped.
# Never touches the real HOME, ~/Library/LaunchAgents, launchd, or relay.morse.im / relay.morse.talk.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$PWD
CLI="node $REPO/dist/cli.js"
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/morse-e2e-requests.XXXXXX")
RELAY_PORT=${RELAY_PORT:-18951}
RELAY=ws://127.0.0.1:$RELAY_PORT
TAG=$RANDOM
WRANGLER=$REPO/relay-cf/node_modules/.bin/wrangler
PIDS=()
stop_port() {
  pkill -TERM -f "wrangler.*persist-to $ROOT" 2>/dev/null || true
  for _ in $(seq 1 50); do lsof -ti "tcp:$1" -sTCP:LISTEN >/dev/null 2>&1 || return 0; sleep 0.2; done
  local pids; pids=$(lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null || true); [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
}
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; stop_port "$RELAY_PORT"; wait 2>/dev/null || true; }
trap cleanup EXIT

as() { local h=$1; shift; HOME=$h MORSE_HOME=$h ANYTOANY_HOME=$h $CLI "$@"; }
pass() { echo "  PASS: $*"; }
fail() { echo "  FAIL: $*"; echo "  (logs in $ROOT)"; exit 1; }
wait_for() { local t=$1; shift; for _ in $(seq 1 $((t * 5))); do if "$@" >/dev/null 2>&1; then return 0; fi; sleep 0.2; done; return 1; }
start_daemon() { # start_daemon <home> <port> <log> [extra args]
  local h=$1 port=$2 log=$3; shift 3
  for p in "$port" "$((port + 1))"; do lsof -ti "tcp:$p" -sTCP:LISTEN >/dev/null 2>&1 && fail "port $p is in use"; done
  HOME=$h MORSE_HOME=$h ANYTOANY_HOME=$h $CLI start --no-notify --port "$port" "$@" >>"$log" 2>&1 &
  PIDS+=($!)
  echo $! >"$h/e2e-daemon.pid" # this test daemon only (never `morse stop`: it may pgrep a real one)
}
stop_daemon() { # stop_daemon <home> <port>
  kill "$(cat "$1/e2e-daemon.pid")" 2>/dev/null || true
  for _ in $(seq 1 50); do lsof -ti "tcp:$2" -sTCP:LISTEN >/dev/null 2>&1 || return 0; sleep 0.2; done
  fail "the test daemon on port $2 did not stop"
}
handle_of() { as "$1" relay show | awk '/^handle:/ && $2 !~ /^\(/ {print $2}'; }
fast_retry() { mkdir -p "$1/.morse"; python3 - "$1/.morse/config.json" <<'PY'
import json,sys; p=sys.argv[1]
try: c=json.load(open(p))
except FileNotFoundError: c={}
c['outbox']={'retryIntervalSec':3,'maxWaitDays':30}; c.setdefault('plugins',{}).setdefault('attendant',{})['enabled']=False  # ADR-066: no real agent answers in e2e
json.dump(c,open(p,'w'),indent=2)
PY
}
send_from() { as "$1" send "$3" "$4" --port "$2" | tee -a "$ROOT/sends.log" | awk '/^queued/{print $2}'; }
# messages from other people in <home>'s mailbox whose text contains <marker>: "<via>" lines
got() { HOME=$1 MORSE_HOME=$1 $CLI inbox --all --json | python3 -c "
import json,sys
for m in json.load(sys.stdin):
  p=m['parts'][0]
  if '$2' in p['text'] and m['from'].get('device'): print(p.get('via',''))"; }
arrived() { [ -n "$(got "$1" "$2")" ]; }
nreq() { HOME=$1 MORSE_HOME=$1 $CLI requests --json | python3 -c "import json,sys; print(len(json.load(sys.stdin)))"; }
req_field() { HOME=$1 MORSE_HOME=$1 $CLI requests --json | python3 -c "import json,sys; r=[x for x in json.load(sys.stdin) if x['handle']=='$2']; print(r[0]['$3'] if r else '')"; }
status_of() { HOME=$1 MORSE_HOME=$1 $CLI inbox --all --json | python3 -c "
import json,sys
m=[m for m in json.load(sys.stdin) if m['id']=='$2'][0]
print('request' if m.get('request') else ('held' if m.get('waiting') and 'accept your message request' in (m.get('lastError') or '') else m['status']))"; }

echo "== setup in $ROOT"
npm run build >/dev/null
test -x "$WRANGLER" || (cd relay-cf && npm install --no-audit --no-fund >/dev/null)
lsof -ti "tcp:$RELAY_PORT" -sTCP:LISTEN >/dev/null 2>&1 && fail "port $RELAY_PORT is in use (set RELAY_PORT)"
mkdir -p "$ROOT/xdg" "$ROOT/cf-state"
( cd relay-cf && XDG_CONFIG_HOME=$ROOT/xdg WRANGLER_SEND_METRICS=false CLOUDFLARE_API_TOKEN= CLOUDFLARE_ACCOUNT_ID= \
    "$WRANGLER" dev --port "$RELAY_PORT" --inspector-port 0 --persist-to "$ROOT/cf-state" --log-level log --var "ADMIN_KEY:e2e-$RANDOM$RANDOM" >"$ROOT/relay.log" 2>&1 ) &
PIDS+=($!)
wait_for 60 curl -sf "http://127.0.0.1:$RELAY_PORT/healthz" || fail "relay did not come up (see $ROOT/relay.log)"
pass "relay up (wrangler dev, isolated XDG_CONFIG_HOME)"

# run_part <label> <lan|nolan> <alice port> <bob port> <carol port>
run_part() {
  local L=$1 MODE=$2 PA=$3 PB=$4 PC=$5
  local HA=$ROOT/$L-alice HB=$ROOT/$L-bob HC=$ROOT/$L-carol
  local LOGA=$ROOT/$L-alice.log LOGB=$ROOT/$L-bob.log LOGC=$ROOT/$L-carol.log
  local NA=e2e-req-$L-alice-$TAG NB=e2e-req-$L-bob-$TAG NC=e2e-req-$L-carol-$TAG
  local VIA=relay EXTRA=(--no-lan)
  [ "$MODE" = lan ] && { VIA=lan; EXTRA=(); }
  mkdir -p "$HA" "$HB" "$HC"

  echo "== $L. three people join (random addresses), nobody paired"
  as "$HA" join --relay "$RELAY" --name "$NA" --agent a1 >/dev/null
  as "$HB" join --relay "$RELAY" --name "$NB" --agent b1 >/dev/null
  as "$HC" join --relay "$RELAY" --name "$NC" --agent c1 >/dev/null
  ALICE=$(handle_of "$HA") BOB=$(handle_of "$HB") CAROL=$(handle_of "$HC")
  [ -n "$ALICE" ] && [ -n "$BOB" ] && [ -n "$CAROL" ] || fail "could not read the addresses"
  echo "   alice = morse.im/$ALICE · bob = morse.im/$BOB · carol = morse.im/$CAROL"
  for h in "$HA" "$HB" "$HC"; do fast_retry "$h"; done
  start_daemon "$HA" "$PA" "$LOGA" ${EXTRA[@]+"${EXTRA[@]}"}
  start_daemon "$HB" "$PB" "$LOGB" ${EXTRA[@]+"${EXTRA[@]}"}
  start_daemon "$HC" "$PC" "$LOGC" ${EXTRA[@]+"${EXTRA[@]}"}
  for l in "$LOGA" "$LOGB" "$LOGC"; do wait_for 20 grep -q "relay: connected" "$l" || fail "a daemon did not connect ($l)"; done
  if [ "$MODE" = lan ]; then
    grep -h "^lan: device" "$LOGA" "$LOGB" "$LOGC" | sed 's/^/   /'
    wait_for 30 sh -c "HOME=$HB MORSE_HOME=$HB $CLI peers --port $PB | grep -q '$NA'" || fail "bob did not discover alice over mDNS"
    wait_for 30 sh -c "HOME=$HC MORSE_HOME=$HC $CLI peers --port $PC | grep -q '$NA'" || fail "carol did not discover alice over mDNS"
    wait_for 30 sh -c "HOME=$HA MORSE_HOME=$HA $CLI peers --port $PA | grep -q '$NB'" || fail "alice did not discover bob over mDNS"
    pass "daemons up with the LAN layer; the test devices see each other over mDNS"
  else
    pass "daemons up (--no-lan)"
  fi

  echo "== $L.1 bob sends alice 3 messages → 1 request, 0 in the inbox; bob holds the rest"
  B1=$(send_from "$HB" "$PB" "morse.im/$ALICE" "$L-R1 hello alice, bob here")
  wait_for 25 sh -c "[ \"\$(HOME=$HB MORSE_HOME=$HB $CLI inbox --all --json | grep -c '\"request\": true')\" = 1 ]" || fail "bob's first message never became 'request pending'"
  B2=$(send_from "$HB" "$PB" "morse.im/$ALICE" "$L-R2 second")
  B3=$(send_from "$HB" "$PB" "morse.im/$ALICE" "$L-R3 third")
  wait_for 25 sh -c "[ \"\$(HOME=$HB MORSE_HOME=$HB $CLI inbox --all --json | grep -c 'accept your message request')\" -ge 2 ]" || fail "bob did not hold R2/R3"
  sleep 7 # > 2 outbox retries (3 s): held messages must stay held, the request count must stay 1
  [ "$(nreq "$HA")" = 1 ] || fail "alice should have exactly 1 request (has $(nreq "$HA"))"
  [ "$(req_field "$HA" "$BOB" count)" = 1 ] || fail "held messages reached alice (count $(req_field "$HA" "$BOB" count))"
  [ "$(req_field "$HA" "$BOB" via)" = "morse-$VIA" ] || fail "the request came via $(req_field "$HA" "$BOB" via), expected morse-$VIA"
  [ -z "$(got "$HA" "$L-R")" ] || fail "a request reached alice's inbox"
  as "$HA" pull --inbox | grep -q "$L-R1" && fail "pull showed a message request"
  OUT=$(as "$HA" inbox); echo "$OUT" | sed 's/^/   alice inbox: /'
  grep -q "1 message request(s) from addresses you have not accepted — not in this inbox. Tell your owner; only they can accept (morse contact)" <<<"$OUT" || fail "alice's inbox does not mention the request"
  OUT=$(as "$HA" requests); echo "$OUT" | sed 's/^/   alice requests: /'
  grep -q "  morse.im/$BOB/b1  device $NB" <<<"$OUT" || fail "requests list lacks the address / device (ADR-065: no nickname)"
  grep -q "$L-R1 hello alice" <<<"$OUT" || fail "requests list lacks the preview"
  [ "$(status_of "$HB" "$B1")" = request ] && [ "$(status_of "$HB" "$B2")" = held ] && [ "$(status_of "$HB" "$B3")" = held ] || fail "bob's statuses: $(status_of "$HB" "$B1") $(status_of "$HB" "$B2") $(status_of "$HB" "$B3")"
  as "$HB" inbox --all | grep -E "$L-R[123]" | sed 's/^/   bob outbox: /'
  as "$HB" inbox --all | grep "$L-R1" | grep -q "request pending" || fail "bob's inbox does not say 'request pending'"
  grep "${B1:0:8}" "$LOGB" | grep -q "is in their message requests (request pending, via $VIA)" || fail "bob's log does not say request pending via $VIA"
  grep -q "message request from Bob $L (morse.im/$BOB)" "$LOGA" || fail "alice's log does not mention the request"
  [ -z "$(as "$HA" pair list | grep "$BOB" || true)" ] || fail "alice paired bob without accepting"
  pass "1 request (via $VIA), inbox and pull empty, footer shown; bob: R1 request pending, R2/R3 held"

  echo "== $L.2 alice accepts → inbox; bob is told, the held ones arrive; both ways work"
  OUT=$(as "$HA" requests accept "morse.talk/$BOB" --port "$PA"); echo "$OUT" | sed 's/^/   alice: /'
  grep -q "told them" <<<"$OUT" || fail "accept did not tell bob through the daemon"
  [ "$(nreq "$HA")" = 0 ] || fail "the request is still there"
  [ -n "$(got "$HA" "$L-R1")" ] || fail "R1 is not in alice's inbox after accept"
  wait_for 25 arrived "$HA" "$L-R2" || fail "held R2 did not arrive after accept"
  wait_for 25 arrived "$HA" "$L-R3" || fail "held R3 did not arrive after accept"
  grep -q "accepted your message request (they told us)" "$LOGB" || fail "bob's daemon did not get the accepted notice"
  [ "$(status_of "$HB" "$B1")" = delivered ] || fail "bob's R1 still says $(status_of "$HB" "$B1")"
  B4=$(send_from "$HB" "$PB" "morse.im/$ALICE" "$L-R4 after accept")
  wait_for 25 arrived "$HA" "$L-R4" || fail "R4 did not arrive"
  [ "$(got "$HA" "$L-R4")" = "morse-$VIA" ] || fail "R4 came via $(got "$HA" "$L-R4"), expected morse-$VIA"
  grep "${B4:0:8}" "$LOGB" | grep -q "delivered via $VIA" || fail "R4 not delivered via $VIA"
  A1=$(send_from "$HA" "$PA" "morse.im/$BOB" "$L-A1 hi bob")
  wait_for 25 arrived "$HB" "$L-A1" || fail "alice's reply did not reach bob"
  as "$HA" inbox --all | grep -E "$L-R[1-4]" | sed 's/^/   alice inbox: /'
  as "$HA" inbox | grep -A1 "$L-R4" | grep -q "同伴消息" || fail "bob's message is not labelled as a peer message"
  pass "accepted: R1 in the inbox, held R2/R3 delivered, R4 and alice's reply go normally (via $VIA)"

  echo "== $L.3 carol writes; alice declines → carol's next message is dropped"
  send_from "$HC" "$PC" "morse.im/$ALICE" "$L-C1 hi from carol" >/dev/null
  wait_for 25 sh -c "[ \"\$(HOME=$HA MORSE_HOME=$HA $CLI requests --json | grep -c '\"handle\": \"$CAROL\"')\" = 1 ]" || fail "carol's request did not arrive"
  OUT=$(as "$HA" requests decline "morse.talk/$CAROL"); echo "   alice: $OUT"
  grep -q "declined morse.im/$CAROL" <<<"$OUT" || fail "decline failed"
  C2=$(send_from "$HC" "$PC" "morse.im/$ALICE" "$L-C2 still there?")
  wait_for 25 sh -c "HOME=$HC MORSE_HOME=$HC $CLI inbox --all | grep '${C2:0:8}' | grep -q 'accept your message request'" || fail "carol did not hold C2"
  # carol's device holds C2 and tries one held message again only every 10 min; a restart
  # tries at once — that try reaches alice, who drops it (declined = blocked)
  stop_daemon "$HC" "$PC"
  start_daemon "$HC" "$PC" "$LOGC" ${EXTRA[@]+"${EXTRA[@]}"}
  wait_for 25 grep -q "morse.im/$CAROL — you removed them or declined their request" "$LOGA" || fail "alice did not drop carol's message"
  sleep 4
  [ "$(nreq "$HA")" = 0 ] || fail "carol has a request again"
  [ -z "$(got "$HA" "$L-C")" ] || fail "carol's message reached alice"
  grep "you removed them or declined" "$LOGA" | head -2 | sed 's/^/   alice.log: /'
  pass "declined: carol's later message dropped, nothing stored"
}

run_part relay nolan 17901 17911 17921
run_part lan lan 17931 17941 17961

echo "== no 'anyd' in the daemon logs; stop every test process"
if grep -nE "\banyd\b" "$ROOT"/*-alice.log "$ROOT"/*-bob.log "$ROOT"/*-carol.log; then fail "old command name in the logs"; fi
cleanup
trap - EXIT
sleep 1
for p in 17901 17911 17921 17931 17941 17961; do
  pgrep -f "dist/cli.js start --no-notify --port $p" >/dev/null && fail "the test daemon on port $p is still running"
  lsof -ti "tcp:$p" -sTCP:LISTEN >/dev/null 2>&1 && fail "port $p still has a listener"
done
lsof -ti "tcp:$RELAY_PORT" -sTCP:LISTEN >/dev/null 2>&1 && fail "the relay port still has a listener"
pgrep -f "persist-to $ROOT" >/dev/null && fail "wrangler dev is still running"
pass "no test process left"
echo "== ALL CHECKS PASSED (logs in $ROOT)"
