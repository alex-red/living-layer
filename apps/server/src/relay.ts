import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SavedCamera } from '@livinglayer/domain';

/**
 * Listeners newer mediamtx versions open on every interface unless told not
 * to, set through the environment because an older one refuses a config key
 * it doesn't know: MoQ (Media over QUIC) on port 8892.
 */
export const RELAY_ENV = { MTX_MOQ: 'no' };

/** What the lab needs of a relay; tests pass their own. */
export interface Relay {
  sync(cameras: SavedCamera[]): Promise<void>;
  whepFor(camera: SavedCamera): string | null;
  rtspFor(camera: SavedCamera): string | null;
  /** What another machine on the network (the GPU tracker) reads instead of the camera, when it may. */
  remoteRtspFor?(camera: SavedCamera): string | null;
  stop(): void;
}

/** A machine on the network allowed to read the relay's RTSP: the GPU tracker. */
export interface RelayReader {
  /** This machine's address as that machine reaches it. */
  host: string;
  /** Its password (user `gpu`), and the addresses it may read from (any when empty). */
  pass: string;
  ips: string[];
}

/**
 * Saved RTSP cameras through one mediamtx the server runs: it reads each
 * camera once, on demand, and serves it as WebRTC (WHEP) to the lab's tab and
 * as RTSP to the watcher. A tab plays the camera at its own frame rate with
 * ~100 ms latency instead of the server's MJPEG, and the camera has one
 * client however many read it. Its HTTP and RTSP stay on loopback (the lab's
 * routes forward to them); with a `mediaHost`, for a lab opened from another
 * machine, its WebRTC media is also offered there, else that tab has no path
 * to it and falls back to the MJPEG.
 *
 * With a `reader` (the GPU tracker), its RTSP is also served on the network,
 * to that one reader with its own password, so the camera keeps one client:
 * a Wi-Fi camera split between two full streams freezes for both.
 *
 * Without mediamtx (or with `CAMERA_RELAY=off`) there is no relay, and saved
 * cameras fall back to the server's MJPEG preview and their own RTSP.
 */
export class CameraRelay implements Relay {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private written = '';
  private dir: string;
  constructor(
    dataDir: string,
    private binary: string,
    /** WHEP on this port; RTSP on the next, WebRTC media (UDP) on the one after. */
    private port: number,
    /** This machine's network address, when the lab is served beyond loopback. */
    private mediaHost?: string,
    private reader?: RelayReader,
  ) {
    this.dir = join(dataDir, 'relay');
  }
  /** A relay when mediamtx can be found, else null. */
  static find(
    dataDir: string,
    binary: string,
    port: number,
    mediaHost?: string,
    reader?: RelayReader,
  ): CameraRelay | null {
    if (binary === 'off') return null;
    const found = Bun.which(binary);
    return found ? new CameraRelay(dataDir, found, port, mediaHost, reader) : null;
  }
  /** mediamtx reads RTSP(S); an HTTP stream stays on the server's preview. */
  static relays(camera: SavedCamera) {
    return /^rtsps?:\/\//.test(camera.url);
  }
  private get running() {
    return this.proc !== null && this.proc.exitCode === null && this.proc.signalCode === null;
  }
  private path(camera: SavedCamera) {
    return `cam-${camera.id}`;
  }
  /** Where the lab's WHEP route forwards to, while the relay runs. */
  whepFor(camera: SavedCamera): string | null {
    return this.running && CameraRelay.relays(camera)
      ? `http://127.0.0.1:${this.port}/${this.path(camera)}/whep`
      : null;
  }
  /** What ffmpeg reads instead of the camera, while the relay runs. */
  rtspFor(camera: SavedCamera): string | null {
    return this.running && CameraRelay.relays(camera)
      ? `rtsp://127.0.0.1:${this.port + 1}/${this.path(camera)}`
      : null;
  }
  /** What the GPU tracker reads instead of the camera, while the relay runs and it may. */
  remoteRtspFor(camera: SavedCamera): string | null {
    const r = this.reader;
    return r && this.running && CameraRelay.relays(camera)
      ? `rtsp://gpu:${encodeURIComponent(r.pass)}@${r.host}:${this.port + 1}/${this.path(camera)}`
      : null;
  }
  private config(cameras: SavedCamera[]) {
    const s = JSON.stringify;
    const paths = cameras.filter(CameraRelay.relays).flatMap((c) => [
      `  ${this.path(c)}:`,
      `    source: ${s(c.url)}`,
      '    rtspTransport: tcp',
      '    sourceOnDemand: true',
      '    sourceOnDemandStartTimeout: 15s',
      // Kept open a minute after its last reader, so a tab reloading or a still soon
      // after doesn't connect to the camera again and wait for its keyframe.
      '    sourceOnDemandCloseAfter: 60s',
    ]);
    return [
      '# Written by the lab (apps/server/src/relay.ts); changes are overwritten.',
      'logLevel: warn',
      'authMethod: internal',
      'authInternalUsers:',
      '  - user: any',
      '    ips: ["127.0.0.1", "::1"]',
      '    permissions:',
      '      - action: read',
      ...(this.reader
        ? [
            '  - user: gpu',
            `    pass: ${s(this.reader.pass)}`,
            ...(this.reader.ips.length ? [`    ips: ${s(this.reader.ips)}`] : []),
            '    permissions:',
            '      - action: read',
          ]
        : []),
      'api: false',
      'metrics: false',
      'pprof: false',
      'playback: false',
      'rtmp: false',
      'hls: false',
      'srt: false',
      'rtsp: true',
      'rtspTransports: [tcp]',
      // On the network only for the GPU tracker, whose user needs its password there.
      `rtspAddress: ${this.reader ? '' : '127.0.0.1'}:${this.port + 1}`,
      'webrtc: true',
      `webrtcAddress: 127.0.0.1:${this.port}`,
      'webrtcAllowOrigins: []',
      `webrtcLocalUDPAddress: ${this.mediaHost ? '' : '127.0.0.1'}:${this.port + 2}`,
      'webrtcIPsFromInterfaces: false',
      `webrtcAdditionalHosts: ${JSON.stringify(['127.0.0.1', ...(this.mediaHost ? [this.mediaHost] : [])])}`,
      'webrtcICEServers2: []',
      ...(paths.length ? ['paths:', ...paths] : ['paths: {}']),
      '',
    ].join('\n');
  }
  /**
   * Relays these cameras, starting mediamtx if it isn't running. mediamtx
   * reloads its file when it changes, so a saved or removed camera keeps the
   * others streaming. The file holds camera URLs with their passwords: only
   * this user can read it.
   */
  async sync(cameras: SavedCamera[]) {
    const text = this.config(cameras);
    const file = join(this.dir, 'mediamtx.yml');
    if (text !== this.written) {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(file, text, { mode: 0o600 });
      chmodSync(file, 0o600);
      this.written = text;
    }
    if (this.running) return;
    await this.endEarlier();
    this.proc = Bun.spawn([this.binary, file], {
      env: { ...process.env, ...RELAY_ENV },
      stdin: 'ignore',
      stdout: Bun.file(join(this.dir, 'mediamtx.log')),
      stderr: 'ignore',
    });
    writeFileSync(this.pidFile, String(this.proc.pid));
    await this.listening();
  }
  private get pidFile() {
    return join(this.dir, 'mediamtx.pid');
  }
  /**
   * Ends a relay an earlier server left running (a crash, or `--watch`
   * reloading in place), which would hold the ports with an old config.
   */
  private async endEarlier() {
    let pid = 0;
    try {
      pid = Number(readFileSync(this.pidFile, 'utf8'));
    } catch {
      return;
    }
    const alive = () => {
      if (!Number.isInteger(pid) || pid <= 1) return false;
      // Only a mediamtx: the id may have gone to another process since.
      const ps = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'comm=']);
      return ps.stdout.toString().trim().endsWith('mediamtx');
    };
    if (alive()) {
      process.kill(pid, 'SIGTERM');
      for (let i = 0; i < 30 && alive(); i++) await Bun.sleep(100);
    }
    rmSync(this.pidFile, { force: true });
  }
  /** Waits up to 3 s for the RTSP port, so the watcher's first read finds it. */
  private async listening() {
    for (let i = 0; i < 30 && this.running; i++) {
      const open = await Bun.connect({
        hostname: '127.0.0.1',
        port: this.port + 1,
        socket: { data() {} },
      })
        .then((socket) => (socket.end(), true))
        .catch(() => false);
      if (open) return;
      await Bun.sleep(100);
    }
  }
  stop() {
    // Only this relay's own file: a server that never ran one leaves another's alone.
    if (!this.proc) return;
    this.proc.kill();
    this.proc = null;
    rmSync(this.pidFile, { force: true });
  }
}
