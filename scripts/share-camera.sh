#!/bin/sh
# Share this device's webcam (built-in or USB) on the local network for the
# LivingLayer camera labs. One H.264 encode feeds both outputs:
#   WebRTC (WHEP)  http://<this-ip>:8889/cam/whep   what the labs play, ~100 ms latency
#   RTSP           rtsp://<this-ip>:8554/cam        for VLC, ffplay, Home Assistant, ...
# The stream is advertised over mDNS as _livinglayer-cam._tcp, so the labs list it
# without any setup. Needs ffmpeg and mediamtx (https://github.com/bluenviron/mediamtx):
#   macOS:  brew install ffmpeg mediamtx
#   Linux:  apt install ffmpeg avahi-utils v4l-utils, plus the mediamtx release binary
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
while [ $# -gt 0 ]; do
  case "$1" in
    --list) list=1 ;;
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

need() { command -v "$1" >/dev/null 2>&1 || { echo "$1 is required. $2" >&2; exit 1; }; }
need ffmpeg 'Install it with your package manager (brew install ffmpeg / apt install ffmpeg).'

if [ "$list" = 1 ]; then
  case "$os" in
    Darwin) ffmpeg -hide_banner -f avfoundation -list_devices true -i '' 2>&1 | grep -A20 'video devices' | grep -B20 -m1 'audio devices' | grep '\[[0-9]' || true ;;
    Linux) if command -v v4l2-ctl >/dev/null 2>&1; then v4l2-ctl --list-devices; else ls /dev/video* 2>/dev/null; fi ;;
  esac
  exit 0
fi

need mediamtx 'Install it from https://github.com/bluenviron/mediamtx/releases (macOS: brew install mediamtx).'

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

case "$os" in
  Darwin) ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo localhost) ;;
  *) ip=$(hostname -I 2>/dev/null | awk '{print $1}') ;;
esac
ip=${ip:-localhost}
how=$([ "$passthrough" = 1 ] && echo 'camera H.264, no re-encode' || echo "$encoder")
echo "Sharing \"$name\" ($device, $size @ ${fps} fps, $how)"
echo "  WebRTC (WHEP): http://$ip:$port/cam/whep"
echo "  Preview page:  http://$ip:$port/cam"
echo "  RTSP:          rtsp://$ip:$rtsp_port/cam"
echo 'The camera labs list it automatically. Ctrl-C to stop.'

mediamtx "$work/mediamtx.yml" &
pids="$pids $!"
wait "$!"
