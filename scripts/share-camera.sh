#!/bin/sh
# Share this device's webcam (built-in or USB) on the local network for the
# Living Layer workspace and camera playground. One H.264 encode feeds both outputs:
#   WebRTC (WHEP)  http://<this-ip>:8889/cam/whep   what Living Layer plays, ~100 ms latency
#   RTSP           rtsp://<this-ip>:8554/cam        for VLC, ffplay, Home Assistant, ...
# The stream is advertised over mDNS as _livinglayer-cam._tcp, so both list it
# without any setup. Needs ffmpeg and mediamtx (https://github.com/bluenviron/mediamtx),
# and offers to install whatever is missing: ffmpeg (and on Linux avahi and v4l-utils)
# through the package manager, mediamtx through Homebrew or as the checksum-verified
# release binary in ~/.local/bin.
# Runs on macOS and Linux (including a Raspberry Pi). Stop it with Ctrl-C.
set -eu

usage() {
  cat <<'EOF'
Usage: scripts/share-camera.sh [options]
  --list              list cameras and exit
  --device ID         camera index on macOS (default 0), device path on Linux (default /dev/video0)
  --size WxH          capture size (default 1280x720)
  --fps N             frame rate (default 30)
  --bitrate RATE      H.264 bitrate (default 2M)
  --encoder NAME      ffmpeg H.264 encoder (default: hardware where available, else libx264)
  --name NAME         name the labs show (default: "<hostname> camera")
  --port N            WebRTC/WHEP port (default 8889; RTSP uses 8554, WebRTC media UDP 8189)
  -y, --yes           install missing dependencies without asking
EOF
}

os=$(uname -s)
device=''
size=1280x720
fps=30
bitrate=2M
encoder=''
name="$(hostname -s 2>/dev/null || hostname) camera"
port=8889
rtsp_port=8554
list=0
yes=0
while [ $# -gt 0 ]; do
  case "$1" in
    --list) list=1 ;;
    -y|--yes) yes=1 ;;
    --device) device=$2; shift ;;
    --size) size=$2; shift ;;
    --fps) fps=$2; shift ;;
    --bitrate) bitrate=$2; shift ;;
    --encoder) encoder=$2; shift ;;
    --name) name=$2; shift ;;
    --port) port=$2; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

have() { command -v "$1" >/dev/null 2>&1; }
# Yes with --yes; no when nobody can answer; otherwise asks, defaulting to yes.
ask() {
  [ "$yes" = 1 ] && return 0
  [ -t 0 ] || return 1
  printf '%s [Y/n] ' "$1" >&2
  read -r answer || return 1
  case "$answer" in [nN]*) return 1 ;; *) return 0 ;; esac
}
as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }

# Installs packages by their generic names: ffmpeg, avahi, v4l-utils.
pkg_install() {
  if have brew; then
    brew install "$@"
  elif have apt-get; then
    # shellcheck disable=SC2046 # package names never contain spaces
    set -- $(echo "$@" | sed 's/avahi/avahi-utils/')
    as_root apt-get update -qq && as_root apt-get install -y "$@"
  elif have dnf; then
    # shellcheck disable=SC2046
    set -- $(echo "$@" | sed 's/ffmpeg/ffmpeg-free/; s/avahi/avahi-tools/')
    as_root dnf install -y "$@"
  elif have pacman; then
    as_root pacman -S --needed --noconfirm "$@"
  else
    echo "No supported package manager (brew, apt, dnf, pacman). Install $* yourself." >&2
    [ "$os" = Darwin ] && echo 'On macOS, Homebrew is at https://brew.sh.' >&2
    return 1
  fi
}

# Homebrew if present, else the release binary for this OS and CPU, checked
# against the release's published SHA-256 before it is installed.
install_mediamtx() {
  if have brew; then
    brew install mediamtx
    return
  fi
  have curl || { echo 'curl is needed to download mediamtx.' >&2; return 1; }
  case "$(uname -m)" in
    x86_64 | amd64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    armv7l) arch=armv7 ;;
    armv6l) arch=armv6 ;;
    *) echo "mediamtx has no release build for $(uname -m)." >&2; return 1 ;;
  esac
  platform=$(echo "$os" | tr '[:upper:]' '[:lower:]')
  releases=https://github.com/bluenviron/mediamtx/releases
  tag=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$releases/latest" | sed 's#.*/tag/##')
  case "$tag" in v[0-9]*) ;; *) echo 'Could not find the latest mediamtx release.' >&2; return 1 ;; esac
  asset="mediamtx_${tag}_${platform}_${arch}.tar.gz"
  dl=$(mktemp -d "${TMPDIR:-/tmp}/mediamtx.XXXXXX")
  echo "Downloading $asset" >&2
  if ! curl -fsSL -o "$dl/$asset" "$releases/download/$tag/$asset" ||
    ! curl -fsSL -o "$dl/checksums.sha256" "$releases/download/$tag/checksums.sha256"; then
    rm -rf "$dl"
    echo 'Download failed.' >&2
    return 1
  fi
  expected=$(grep "[ *]$asset\$" "$dl/checksums.sha256" | awk '{print $1}')
  if have sha256sum; then actual=$(sha256sum "$dl/$asset" | awk '{print $1}'); else actual=$(shasum -a 256 "$dl/$asset" | awk '{print $1}'); fi
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    rm -rf "$dl"
    echo "Checksum mismatch for $asset; nothing was installed." >&2
    return 1
  fi
  tar -xzf "$dl/$asset" -C "$dl" mediamtx
  mkdir -p "$HOME/.local/bin"
  mv "$dl/mediamtx" "$HOME/.local/bin/mediamtx"
  chmod +x "$HOME/.local/bin/mediamtx"
  rm -rf "$dl"
  echo "Installed mediamtx $tag to ~/.local/bin" >&2
}

find_mediamtx() {
  mediamtx=$(command -v mediamtx 2>/dev/null || true)
  [ -n "$mediamtx" ] || { [ -x "$HOME/.local/bin/mediamtx" ] && mediamtx=$HOME/.local/bin/mediamtx; }
  [ -n "$mediamtx" ]
}

# Required: ffmpeg, and mediamtx unless only listing cameras.
missing=''
have ffmpeg || missing=ffmpeg
[ "$list" = 1 ] || find_mediamtx || missing="$missing mediamtx"
missing=${missing# }
if [ -n "$missing" ]; then
  if ! ask "Missing: $missing. Install now?"; then
    echo "Install $missing, then run this again (or pass --yes to have it done for you)." >&2
    exit 1
  fi
  case " $missing " in *' ffmpeg '*) pkg_install ffmpeg || exit 1 ;; esac
  case " $missing " in *' mediamtx '*) install_mediamtx || exit 1 ;; esac
  have ffmpeg || { echo 'ffmpeg is still not on PATH.' >&2; exit 1; }
  [ "$list" = 1 ] || find_mediamtx || { echo 'mediamtx is still not found.' >&2; exit 1; }
fi

# Recommended on Linux: avahi announces the camera to the labs, v4l-utils
# finds cameras that already encode H.264 so they skip the re-encode.
if [ "$os" = Linux ]; then
  extras=''
  have avahi-publish-service || extras=avahi
  have v4l2-ctl || extras="$extras v4l-utils"
  extras=${extras# }
  if [ -n "$extras" ] && ask "Recommended: $extras (labs find the camera by itself, H.264 cameras skip the re-encode). Install?"; then
    # shellcheck disable=SC2086 # one word per package
    pkg_install $extras || echo "Continuing without $extras." >&2
  fi
fi

if [ "$list" = 1 ]; then
  case "$os" in
    Darwin) ffmpeg -hide_banner -f avfoundation -list_devices true -i '' 2>&1 | grep -A20 'video devices' | grep -B20 -m1 'audio devices' | grep '\[[0-9]' || true ;;
    Linux) if command -v v4l2-ctl >/dev/null 2>&1; then v4l2-ctl --list-devices; else ls /dev/video* 2>/dev/null; fi ;;
  esac
  exit 0
fi


has_encoder() { ffmpeg -hide_banner -encoders 2>/dev/null | grep -q " $1 "; }
gop=$fps # a keyframe every second, so a lab that joins late starts within a second

# Capture: ask the camera for the cheapest format to decode. On Linux a camera
# that already encodes H.264 is passed through untouched (no encode at all).
passthrough=0
case "$os" in
  Darwin)
    device=${device:-0}
    input="-f avfoundation -framerate $fps -video_size $size -pixel_format nv12 -i $device:none"
    [ -n "$encoder" ] || { has_encoder h264_videotoolbox && encoder=h264_videotoolbox; }
    ;;
  Linux)
    device=${device:-/dev/video0}
    [ -e "$device" ] || { echo "No camera at $device. Try --list." >&2; exit 1; }
    format=mjpeg
    if [ -z "$encoder" ] && command -v v4l2-ctl >/dev/null 2>&1 &&
      v4l2-ctl -d "$device" --list-formats 2>/dev/null | grep -q "'H264'"; then
      format=h264
      passthrough=1
    fi
    input="-f v4l2 -input_format $format -framerate $fps -video_size $size -i $device"
    ;;
  *) echo "Unsupported OS: $os (macOS and Linux only)." >&2; exit 1 ;;
esac

# Encode: browsers decode constrained-baseline H.264 in hardware; no B-frames keeps latency flat.
if [ "$passthrough" = 1 ]; then
  codec='-c:v copy'
else
  encoder=${encoder:-libx264}
  case "$encoder" in
    h264_videotoolbox) codec="-c:v h264_videotoolbox -realtime 1 -allow_sw 1 -profile:v baseline -b:v $bitrate" ;;
    libx264) codec="-c:v libx264 -preset ultrafast -tune zerolatency -profile:v baseline -pix_fmt yuv420p -b:v $bitrate -maxrate $bitrate -bufsize $bitrate" ;;
    *) codec="-c:v $encoder -pix_fmt yuv420p -b:v $bitrate" ;;
  esac
  codec="$codec -g $gop -bf 0"
fi
ffmpeg_cmd="ffmpeg -hide_banner -loglevel error -nostdin $input $codec -an -f rtsp -rtsp_transport tcp rtsp://127.0.0.1:$rtsp_port/cam"

work=$(mktemp -d "${TMPDIR:-/tmp}/share-camera.XXXXXX")
pids=''
cleanup() {
  trap - EXIT INT TERM
  for pid in $pids; do kill "$pid" 2>/dev/null || true; done
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

cat >"$work/mediamtx.yml" <<EOF
logLevel: warn
api: no
metrics: no
pprof: no
playback: no
rtmp: no
hls: no
srt: no
rtsp: yes
rtspAddress: :$rtsp_port
webrtc: yes
webrtcAddress: :$port
webrtcLocalUDPAddress: :8189
paths:
  cam:
    runOnInit: $ffmpeg_cmd
    runOnInitRestart: yes
EOF

# Advertise. TXT keys: path (WHEP is http://host:port/<path>/whep), rtsp (port), name.
if [ "$os" = Darwin ] && command -v dns-sd >/dev/null 2>&1; then
  dns-sd -R "$name" _livinglayer-cam._tcp local "$port" path=cam "rtsp=$rtsp_port" "name=$name" >/dev/null 2>&1 &
  pids="$pids $!"
elif command -v avahi-publish-service >/dev/null 2>&1; then
  avahi-publish-service "$name" _livinglayer-cam._tcp "$port" path=cam "rtsp=$rtsp_port" "name=$name" >/dev/null 2>&1 &
  pids="$pids $!"
else
  echo 'No mDNS publisher (dns-sd or avahi-publish-service): add the WHEP URL below to CAMERA_STREAMS in the lab .env.' >&2
fi

# Every LAN address, skipping loopback, link-local and VM/container bridges
# (only their guests could reach those). The primary one, the address of the
# interface traffic normally leaves by, goes first.
case "$os" in
  Darwin)
    primary=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
    addresses=$(ifconfig 2>/dev/null | awk '/^[a-z]/ { i = $1 } $1 == "inet" && i !~ /^(lo|bridge)/ { print $2 }')
    ;;
  *)
    primary=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')
    addresses=$(ip -4 -o addr show scope global 2>/dev/null |
      awk '$2 !~ /^(lo|docker|br-|veth|virbr)/ { sub(/\/.*/, "", $4); print $4 }')
    [ -n "$addresses" ] || addresses=$(hostname -I 2>/dev/null | tr ' ' '\n')
    ;;
esac
addresses=$(printf '%s\n' "$addresses" | grep -Ev '^(127\.|169\.254\.|$)' || true)
ip=${primary:-$(printf '%s\n' "$addresses" | head -n1)}
others=$(printf '%s\n' "$addresses" | grep -vxF "${ip:-none}" | tr '\n' ' ' || true)

how=$([ "$passthrough" = 1 ] && echo 'camera H.264, no re-encode' || echo "$encoder")
echo "Sharing \"$name\" ($device, $size @ ${fps} fps, $how) on the network"
if [ -z "$ip" ]; then
  echo 'No network address found: only this machine can connect.' >&2
  ip=localhost
fi
echo "  Network IP:    $ip"
echo "  WebRTC (WHEP): http://$ip:$port/cam/whep"
echo "  Preview page:  http://$ip:$port/cam"
echo "  RTSP:          rtsp://$ip:$rtsp_port/cam"
[ -z "${others% }" ] || echo "  Also on:       ${others% }"
echo 'The camera labs list it automatically. Ctrl-C to stop.'

"$mediamtx" "$work/mediamtx.yml" &
pids="$pids $!"
wait "$!"
