import {
  SWITCHABLE_DOMAINS,
  WARM_KELVIN,
  type LampResult,
  type LightLook,
} from '@livinglayer/domain';
import type { Config, Fetcher } from './config.js';
import { LabError } from './errors.js';

interface State {
  state: string;
  attributes: Record<string, unknown>;
}
/** One entity Home Assistant has that Living Layer could switch, as the lab lists it. */
interface HaEntity {
  entityId: string;
  /** Its friendly name in Home Assistant, else the entity id. */
  name: string;
  domain: (typeof SWITCHABLE_DOMAINS)[number];
  state: string;
}
const NOT_CONNECTED =
  'Home Assistant isn’t connected: sign in under Home Assistant → Devices it can switch, in the lab’s outline.';
/** Where Home Assistant is and the token to call it with; empty strings when it isn't. */
export interface HaConnection {
  url: string;
  token: string;
}
/**
 * Home Assistant is asked for the state this often after an action, for about
 * 3 s in all. The light changes when the action is taken; this only decides
 * how soon the check that switched it is done.
 */
const CONFIRM_POLL_MS = 100;
const CONFIRM_POLLS = 30;
export interface SwitchOptions {
  /**
   * Return once Home Assistant has taken the action, with the state check
   * still running as `confirming`, so what switched it isn't held up.
   */
  background?: boolean;
}
/** A switch's result; `confirming` is the full result to come, when checked in the background. */
export type Switched = LampResult & { confirming?: Promise<LampResult> };
/**
 * Home Assistant lights and switches. Every action is one explicit request,
 * then a short poll of the entity's state; nothing is retried.
 */
export class ControlAdapter {
  constructor(
    private config: Config,
    private fetcher: Fetcher = fetch,
    private sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    {
      allowed = () => [...config.haLights, ...config.haSwitches],
      connection = () => ({ url: config.haUrl, token: config.haToken }),
    }: {
      /** What may be switched: `.env`'s lights and switches, unless the server adds the lab's. */
      allowed?: () => string[];
      /** `.env`'s URL and token, unless the server has a sign-in from the lab. */
      connection?: () => HaConnection;
    } = {},
  ) {
    this.allowed = allowed;
    this.connection = connection;
  }
  private allowed: () => string[];
  private connection: () => HaConnection;
  /**
   * Everything Home Assistant has that turns on and off (lights, switches,
   * fans, helper toggles), read from its states. Only reads; switches nothing.
   */
  async entities(): Promise<HaEntity[]> {
    const c = this.config;
    const { url, token } = this.connection();
    if (!url || !token) throw new LabError('ha_not_connected', NOT_CONNECTED, 409);
    let response: Response;
    try {
      response = await this.fetcher(`${url}/api/states`, {
        signal: AbortSignal.timeout(c.timeoutMs),
        redirect: 'error',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      throw new LabError(
        'ha_unreachable',
        `Home Assistant didn’t answer at ${url}. Open that address in a browser on this machine; use the one that works, with its port (usually :8123).`,
        502,
      );
    }
    if (response.status === 401 || response.status === 403)
      throw new LabError(
        'ha_token',
        'Home Assistant refused the token: it may have been revoked. Sign in again in the Home Assistant panel.',
        502,
      );
    if (!response.ok)
      throw new LabError(
        'ha_request',
        `Home Assistant couldn’t list its entities (HTTP ${response.status}).`,
        502,
      );
    const states = (await response.json().catch(() => null)) as
      | { entity_id?: unknown; state?: unknown; attributes?: { friendly_name?: unknown } }[]
      | null;
    if (!Array.isArray(states))
      throw new LabError('ha_state', 'Home Assistant returned an invalid list of states.', 502);
    const domains: readonly string[] = SWITCHABLE_DOMAINS;
    return states
      .flatMap((s) => {
        const entityId = String(s?.entity_id ?? '');
        const domain = entityId.split('.')[0]!;
        if (!/^[a-z_]+\.[a-z0-9_]+$/.test(entityId) || !domains.includes(domain)) return [];
        const name = s.attributes?.friendly_name;
        return [
          {
            entityId,
            name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : entityId,
            domain: domain as HaEntity['domain'],
            state: String(s.state ?? 'unknown').slice(0, 40),
          },
        ];
      })
      .sort(
        (a, b) =>
          domains.indexOf(a.domain) - domains.indexOf(b.domain) || a.name.localeCompare(b.name),
      );
  }
  /**
   * Switch one configured light or switch on: the main light unless a rule
   * names another, looking as the zone asks (a light keeps its own unless told).
   */
  turnOn(entity = this.config.haEntity, look?: LightLook, options: SwitchOptions = {}) {
    return this.act(entity, 'on', look, options);
  }
  turnOff(entity: string, options: SwitchOptions = {}) {
    return this.act(entity, 'off', undefined, options);
  }
  /** What each entity can do, read once (`capsOf`) so an action needs no read first. */
  private caps = new Map<string, Caps>();
  private async act(
    entity: string,
    action: 'on' | 'off',
    look: LightLook | undefined,
    { background = false }: SwitchOptions,
  ): Promise<Switched> {
    const c = this.config;
    const { url, token } = this.connection();
    if (!url || !token) throw new LabError('lamp_not_ready', NOT_CONNECTED, 409);
    if (!c.haEnabled)
      throw new LabError(
        'lamp_not_ready',
        'Switching is off: HA_LIVE_ENABLED=false is in .env. Remove it and restart the server to switch devices.',
        409,
      );
    if (!entity)
      throw new LabError(
        'lamp_not_ready',
        'Choose a light first: open Home Assistant in the outline and tick the ones Living Layer may switch.',
        409,
      );
    if (!this.allowed().includes(entity))
      throw new LabError(
        'lamp_unknown',
        `${entity} isn’t one of the devices Living Layer may switch. Tick it in the Home Assistant panel first.`,
        409,
      );
    const domain = entity.split('.')[0]!;
    const thing = domain === 'light' ? 'lamp' : domain === 'fan' ? 'fan' : 'switch';
    const signal = AbortSignal.timeout(c.timeoutMs);
    const request = async (path: string, body?: unknown) => {
      const response = await this.fetcher(`${url}/api/${path}`, {
        method: body ? 'POST' : 'GET',
        signal,
        redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok)
        throw new LabError(
          'ha_request',
          `Home Assistant rejected the ${body ? 'action' : 'state check'} (HTTP ${response.status}).`,
          502,
        );
      return response;
    };
    const statePath = `states/${entity}`;
    // What it can do is read once and kept, so an action needs no read first.
    let caps = this.caps.get(entity);
    if (!caps || Date.now() - caps.at > CAPS_KEPT_MS) {
      const before = (await (await request(statePath)).json()) as State;
      if (!before || typeof before.state !== 'string' || !before.attributes)
        throw new LabError('ha_state', 'Home Assistant returned an invalid state.', 502);
      if (UNAVAILABLE.includes(before.state))
        throw new LabError(
          'ha_unavailable',
          `The configured ${thing} is unavailable in Home Assistant.`,
          409,
        );
      caps = capsOf(before);
      this.caps.set(entity, caps);
    }
    const desired = domain === 'light' && action === 'on' ? desiredFor(look, caps) : {};
    const asked = performance.now();
    // A light switches at once rather than fading in (Hue's default is 0.4 s).
    await request(`services/${domain}/turn_${action}`, {
      entity_id: entity,
      ...desired,
      ...(domain === 'light' ? { transition: 0 } : {}),
    });
    const switched = performance.now();
    // How long Home Assistant took to take the action, then to report the state asked for.
    const ms = () => ({
      switch: Math.round(switched - asked),
      confirm: Math.round(performance.now() - switched),
    });
    const result = (stateConfirmed: boolean, state: string, explanation: string): LampResult => ({
      entityId: entity,
      action,
      accepted: true,
      stateConfirmed,
      physicalEffectVerified: false,
      ms: ms(),
      state,
      desired,
      explanation,
    });
    const confirm = async (): Promise<LampResult> => {
      let latest: State | null = null;
      for (let i = 0; i < CONFIRM_POLLS; i++) {
        try {
          latest = (await (await request(statePath)).json()) as State;
          if (!latest || typeof latest.state !== 'string' || !latest.attributes)
            throw new Error('Invalid state');
        } catch {
          this.caps.delete(entity);
          return result(
            false,
            'unknown',
            `Home Assistant accepted the action, but state verification failed. The ${thing} may have changed; inspect it before retrying. No action retry was made.`,
          );
        }
        if (UNAVAILABLE.includes(latest.state)) {
          // Read again next time, which says so before switching.
          this.caps.delete(entity);
          return result(
            false,
            latest.state,
            `Home Assistant took the action, but the ${thing} is ${latest.state}. No action retry was made.`,
          );
        }
        if (latest.state === action && matches(latest.attributes, desired))
          return result(
            true,
            latest.state,
            `Home Assistant reports the requested state. Observe the physical ${thing} separately; this does not prove a visible change.`,
          );
        if (i < CONFIRM_POLLS - 1) await this.sleep(CONFIRM_POLL_MS);
      }
      // It may have changed what it can do: read it again next time.
      this.caps.delete(entity);
      return result(
        false,
        latest?.state ?? 'unknown',
        'Home Assistant accepted one action, but the requested state was not observed within the verification window. No action retry was made.',
      );
    };
    if (!background) return confirm();
    return {
      ...result(
        false,
        'switching',
        `Home Assistant took the action; whether the ${thing} reports it is being checked.`,
      ),
      confirming: confirm(),
    };
  }
}

/** What an entity can do, as switching needs it: its colour modes and warm-white range. */
interface Caps {
  modes: string[];
  minKelvin: number;
  maxKelvin: number;
  at: number;
}
/** How long what an entity can do is kept before it is read again. */
const CAPS_KEPT_MS = 10 * 60 * 1000;
const UNAVAILABLE = ['unavailable', 'unknown'];
const DIMMABLE = ['brightness', 'color_temp', 'hs', 'xy', 'rgb', 'rgbw', 'rgbww', 'white'];
const COLOURED = ['hs', 'xy', 'rgb', 'rgbw', 'rgbww'];
function capsOf(state: State): Caps {
  const a = state.attributes;
  const min = Number(a.min_color_temp_kelvin ?? 2000);
  const max = Number(a.max_color_temp_kelvin ?? 6500);
  const range = Number.isFinite(min) && Number.isFinite(max) && min > 0 && max >= min;
  return {
    modes: Array.isArray(a.supported_color_modes) ? a.supported_color_modes.map(String) : [],
    minKelvin: range ? min : 2000,
    maxKelvin: range ? max : 6500,
    at: Date.now(),
  };
}
/**
 * What to ask a light for when turning it on, from the zone's look and what
 * the light can do. Keeping its own asks for nothing, so Home Assistant
 * restores its last colour and brightness; a look it can't show is asked for
 * as far as it can (a colour on a white bulb is its brightness).
 */
function desiredFor(look: LightLook | undefined, caps: Caps): LampResult['desired'] {
  if (!look || look.kind === 'keep') return {};
  const dims = caps.modes.some((m) => DIMMABLE.includes(m));
  const desired: LampResult['desired'] = dims ? { brightness_pct: look.brightness } : {};
  if (look.kind === 'warm' && caps.modes.includes('color_temp'))
    desired.color_temp_kelvin = Math.round(
      Math.max(caps.minKelvin, Math.min(caps.maxKelvin, WARM_KELVIN)),
    );
  if (look.kind === 'color' && caps.modes.some((m) => COLOURED.includes(m)))
    desired.rgb_color = look.rgb;
  return desired;
}
/**
 * Whether a light's attributes show what was asked. A colour is judged by hue
 * and saturation (`hs_color`), since a bulb shows the nearest colour it can
 * and reports its own RGB for it; a light that doesn't report them isn't held
 * to the colour.
 */
function matches(a: Record<string, unknown>, desired: LampResult['desired']): boolean {
  if (
    desired.brightness_pct !== undefined &&
    Math.abs(Number(a.brightness) - desired.brightness_pct * 2.55) > 5
  )
    return false;
  if (
    desired.color_temp_kelvin !== undefined &&
    Math.abs(Number(a.color_temp_kelvin) - desired.color_temp_kelvin) > 100
  )
    return false;
  if (desired.rgb_color && Array.isArray(a.hs_color)) {
    const [hue, saturation] = a.hs_color.map(Number) as [number, number];
    const want = hueSaturation(desired.rgb_color);
    if (Math.abs(saturation - want.saturation) > 20) return false;
    // Hue means little for a colour close to white.
    const off = Math.abs(hue - want.hue) % 360;
    if (want.saturation > 15 && Math.min(off, 360 - off) > 20) return false;
  }
  return true;
}
/** Hue (degrees) and saturation (percent) of an RGB colour, as Home Assistant reports `hs_color`. */
function hueSaturation([r, g, b]: [number, number, number]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const hue = !d
    ? 0
    : max === r
      ? ((g - b) / d + 6) % 6
      : max === g
        ? (b - r) / d + 2
        : (r - g) / d + 4;
  return { hue: hue * 60, saturation: max ? (d / max) * 100 : 0 };
}
