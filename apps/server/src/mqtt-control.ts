import type { LampResult } from '@livinglayer/domain';
import { LabError } from './errors.js';
import type { MqttLink } from './mqtt.js';

/** A light or switch reached over MQTT, by the topic it reports its state on. */
export interface MqttDevice {
  entityId: string;
  topic: string;
}
/** Brightness asked of a light turned on: 85%, as the Home Assistant path asks, on a 0–254 scale. */
const BRIGHTNESS = 217;

/**
 * Lights and switches switched over MQTT, for homes without a Home Assistant
 * token: devices that take `{"state":"ON"}` on `<topic>/set` and report JSON
 * with `state` on `<topic>`, as Zigbee2MQTT and the Home Assistant MQTT JSON
 * schema do. One command, not retained, then a short wait for the device's
 * report; nothing is retried.
 */
export class MqttControl {
  constructor(
    private link: MqttLink | null,
    private devices: MqttDevice[],
    private waitMs = 3000,
  ) {}
  has(entity: string) {
    return this.devices.some((d) => d.entityId === entity);
  }
  async act(entity: string, action: 'on' | 'off'): Promise<LampResult> {
    const device = this.devices.find((d) => d.entityId === entity);
    if (!device)
      throw new LabError('lamp_unknown', 'That entity is not one of the MQTT devices.', 409);
    const link = this.link;
    if (!link || link.state !== 'connected')
      throw new LabError(
        'mqtt_not_ready',
        'The MQTT broker isn’t connected, so that device can’t be switched.',
        409,
      );
    const dims = entity.startsWith('light.') && action === 'on';
    const desired: LampResult['desired'] = dims ? { brightness_pct: 85 } : {};
    const wanted = action === 'on' ? 'ON' : 'OFF';
    let latest: { state?: unknown; brightness?: unknown } | null = null;
    const matches = (r: typeof latest) =>
      r?.state === wanted &&
      (!dims || typeof r.brightness !== 'number' || Math.abs(r.brightness - BRIGHTNESS) <= 13);
    const reported = new Promise<boolean>((resolve) => {
      const stop = link.listen(device.topic, (_topic, payload) => {
        try {
          latest = JSON.parse(payload) as typeof latest;
        } catch {
          return;
        }
        if (matches(latest)) {
          stop();
          clearTimeout(timer);
          resolve(true);
        }
      });
      const timer = setTimeout(() => {
        stop();
        resolve(false);
      }, this.waitMs);
    });
    const sent = link.publish({
      topic: `${device.topic}/set`,
      payload: JSON.stringify({ state: wanted, ...(dims ? { brightness: BRIGHTNESS } : {}) }),
      retain: false,
    });
    if (!sent) throw new LabError('mqtt_not_ready', 'The MQTT broker dropped the connection.', 409);
    const confirmed = await reported;
    const thing = entity.startsWith('light.') ? 'lamp' : 'switch';
    const state = (latest as { state?: unknown } | null)?.state;
    return {
      entityId: entity,
      action,
      accepted: true,
      stateConfirmed: confirmed,
      physicalEffectVerified: false,
      state: confirmed ? action : typeof state === 'string' ? state.toLowerCase() : 'unknown',
      desired,
      explanation: confirmed
        ? `The device reported the requested state over MQTT. Observe the physical ${thing} separately; this does not prove a visible change.`
        : 'The command was published, but the device didn’t report the requested state in time. No retry was made.',
    };
  }
}
