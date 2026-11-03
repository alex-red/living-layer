import { type LampResult, SWITCHABLE_DOMAINS } from '@livinglayer/domain';
import type { Config, Fetcher } from './config.js';
import { LabError } from './errors.js';

interface State {
  state: string;
  attributes: Record<string, unknown>;
}
/** One entity Home Assistant has that Living Layer could switch, as the lab lists it. */
export interface HaEntity {
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
 * Home Assistant lights and switches. Every action is one explicit request,
 * then a short poll of the entity's state; nothing is retried.
 */
/**
 * Home Assistant is asked for the state this often after an action, for about
 * 3 s in all. The light changes when the action is taken; this only decides
 * how soon the check that switched it is done.
 */
const CONFIRM_POLL_MS = 100;
const CONFIRM_POLLS = 30;
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
  /** Switch one configured light or switch on: the main light unless a rule names another. */
  turnOn(entity = this.config.haEntity): Promise<LampResult> {
    return this.act(entity, 'on');
  }
  turnOff(entity: string): Promise<LampResult> {
    return this.act(entity, 'off');
  }
  private async act(entity: string, action: 'on' | 'off'): Promise<LampResult> {
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
    const before = (await (await request(statePath)).json()) as State;
    if (!before || typeof before.state !== 'string' || !before.attributes)
      throw new LabError('ha_state', 'Home Assistant returned an invalid state.', 502);
    if (['unavailable', 'unknown'].includes(before.state))
      throw new LabError(
        'ha_unavailable',
        `The configured ${thing} is unavailable in Home Assistant.`,
        409,
      );
    const modes = Array.isArray(before.attributes.supported_color_modes)
      ? before.attributes.supported_color_modes
      : [];
    const desired: LampResult['desired'] = {};
    // Brightness and warmth only mean something for a light being turned on.
    const dims = domain === 'light' && action === 'on';
    if (
      dims &&
      modes.some((mode) =>
        ['brightness', 'color_temp', 'hs', 'xy', 'rgb', 'rgbw', 'rgbww', 'white'].includes(
          String(mode),
        ),
      )
    )
      desired.brightness_pct = 85;
    if (dims && modes.includes('color_temp')) {
      const min = Number(before.attributes.min_color_temp_kelvin ?? 2000);
      const max = Number(before.attributes.max_color_temp_kelvin ?? 6500);
      if (Number.isFinite(min) && Number.isFinite(max) && min > 0 && max >= min)
        desired.color_temp_kelvin = Math.round(Math.max(min, Math.min(max, 2700)));
    }
    const asked = performance.now();
    await request(`services/${domain}/turn_${action}`, { entity_id: entity, ...desired });
    const switched = performance.now();
    // How long Home Assistant took to take the action, then to report the state asked for.
    const ms = () => ({
      switch: Math.round(switched - asked),
      confirm: Math.round(performance.now() - switched),
    });
    let latest = before;
    for (let i = 0; i < CONFIRM_POLLS; i++) {
      try {
        latest = (await (await request(statePath)).json()) as State;
        if (!latest || typeof latest.state !== 'string' || !latest.attributes)
          throw new Error('Invalid state');
      } catch {
        return {
          entityId: entity,
          action,
          accepted: true,
          stateConfirmed: false,
          physicalEffectVerified: false,
          ms: ms(),
          state: 'unknown',
          desired,
          explanation: `Home Assistant accepted the action, but state verification failed. The ${thing} may have changed; inspect it before retrying. No action retry was made.`,
        };
      }
      const brightness = Number(latest.attributes.brightness);
      const temperature = Number(latest.attributes.color_temp_kelvin);
      const matches =
        latest.state === action &&
        (desired.brightness_pct === undefined ||
          Math.abs(brightness - desired.brightness_pct * 2.55) <= 5) &&
        (desired.color_temp_kelvin === undefined ||
          Math.abs(temperature - desired.color_temp_kelvin) <= 100);
      if (matches)
        return {
          entityId: entity,
          action,
          accepted: true,
          stateConfirmed: true,
          physicalEffectVerified: false,
          ms: ms(),
          state: latest.state,
          desired,
          explanation: `Home Assistant reports the requested state. Observe the physical ${thing} separately; this does not prove a visible change.`,
        };
      if (i < CONFIRM_POLLS - 1) await this.sleep(CONFIRM_POLL_MS);
    }
    return {
      entityId: entity,
      action,
      accepted: true,
      stateConfirmed: false,
      physicalEffectVerified: false,
      ms: ms(),
      state: latest.state,
      desired,
      explanation:
        'Home Assistant accepted one action, but the requested state was not observed within the verification window. No action retry was made.',
    };
  }
}
