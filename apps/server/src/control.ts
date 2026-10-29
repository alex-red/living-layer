import type { LampResult } from '@livinglayer/domain';
import type { Config, Fetcher } from './config.js';
import { LabError } from './errors.js';

interface State {
  state: string;
  attributes: Record<string, unknown>;
}
/**
 * Home Assistant lights and switches. Every action is one explicit request,
 * then a short poll of the entity's state; nothing is retried.
 */
export class ControlAdapter {
  constructor(
    private config: Config,
    private fetcher: Fetcher = fetch,
    private sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ) {}
  /** Switch one configured light or switch on: the main light unless a rule names another. */
  turnOn(entity = this.config.haEntity): Promise<LampResult> {
    return this.act(entity, 'on');
  }
  turnOff(entity: string): Promise<LampResult> {
    return this.act(entity, 'off');
  }
  private async act(entity: string, action: 'on' | 'off'): Promise<LampResult> {
    const c = this.config;
    if (!c.haEnabled || !c.haUrl || !c.haToken || !entity) {
      throw new LabError(
        'lamp_not_ready',
        'Configure Home Assistant, one light entity, and explicitly enable the live lamp test first.',
        409,
      );
    }
    if (![...c.haLights, ...c.haSwitches].includes(entity))
      throw new LabError(
        'lamp_unknown',
        'That entity is not one of the configured lights or switches.',
        409,
      );
    const domain = entity.startsWith('switch.') ? 'switch' : 'light';
    const thing = domain === 'light' ? 'lamp' : 'switch';
    const signal = AbortSignal.timeout(c.timeoutMs);
    const request = async (path: string, body?: unknown) => {
      const response = await this.fetcher(`${c.haUrl}/api/${path}`, {
        method: body ? 'POST' : 'GET',
        signal,
        redirect: 'error',
        headers: { Authorization: `Bearer ${c.haToken}`, 'Content-Type': 'application/json' },
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
    await request(`services/${domain}/turn_${action}`, { entity_id: entity, ...desired });
    let latest = before;
    for (let i = 0; i < 6; i++) {
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
          state: latest.state,
          desired,
          explanation: `Home Assistant reports the requested state. Observe the physical ${thing} separately; this does not prove a visible change.`,
        };
      if (i < 5) await this.sleep(500);
    }
    return {
      entityId: entity,
      action,
      accepted: true,
      stateConfirmed: false,
      physicalEffectVerified: false,
      state: latest.state,
      desired,
      explanation:
        'Home Assistant accepted one action, but the requested state was not observed within the verification window. No action retry was made.',
    };
  }
}
